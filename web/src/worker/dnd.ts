import { and, eq, isNull, like, or, sql } from "drizzle-orm";
import type { Env } from "./env";
import type { Db } from "./db/client";
import { appMeta, tasks, users } from "./db/schema";
import { getSettings } from "./settings";
import { parseDeals } from "./serialize";
import { notifyUser } from "./notify";
import { nowIso } from "./dates";
import { isStandingOrder, type AppSettings, type Deal, type PaymentMethod } from "@shared/types";

/**
 * DND CASH (dndcash.oskaraz.com) – the company's payroll and commission system. A closed deal ("נסלק") recorded on
 * a leads task here becomes a new deal there, automatically. The owner's rules: deal type defaults to "sales only";
 * "sales + training" only for the people listed in settings; a standing order carries its number of months.
 * From here we only ever CREATE deals in DND CASH – nothing there is updated or deleted.
 *
 * Sign-in: DND CASH uses an e-mail code and then hands out a 15-minute access token plus a one-year refresh
 * cookie that ROTATES on every refresh (the previous value dies at once). The current refresh token therefore lives
 * in one place only (`app_meta` → `dnd_auth`), is saved the moment it rotates, and every refresh runs under the sync
 * lock so two isolates never race for it.
 */
export const DND_DEFAULT_URL = "https://dndcash.oskaraz.com";
const AUTH_KEY = "dnd_auth";
const LOCK_KEY = "dnd_sync_lock";
const LOCK_MS = 2 * 60 * 1000;
const AGENTS_TTL_MS = 6 * 60 * 60 * 1000;
const ALERT_EVERY_MS = 60 * 60 * 1000;
const MAX_ATTEMPTS = 20;
const UA = "luz-yomi/1.0 (fitness-daily-tasks)";

export const DND_PAYMENT_METHOD: Record<PaymentMethod, string> = {
  credit_card: "CREDIT_CARD",
  bank_transfer: "BANK_TRANSFER",
  standing_order: "STANDING_ORDER",
  bank_standing_order: "STANDING_ORDER_BANK",
  cash: "CASH",
  crypto: "CRYPTO",
  paypal: "PAYPAL",
};

export interface DndAgent {
  id: string;
  email: string | null;
  displayName: string;
  isActive: boolean;
}

export interface DndAuth {
  refreshToken: string;
  accessToken?: string;
  accessExp?: number;
  user?: { displayName?: string; role?: string; email?: string } | null;
  agents?: DndAgent[];
  agentsAt?: number;
  connectedAt?: number;
  lastError?: string | null;
  lastErrorAt?: number;
  lastSyncAt?: number;
  alertedAt?: number;
}

export interface DndStatus {
  connected: boolean;
  user: DndAuth["user"] | null;
  agents: DndAgent[];
  lastError: string | null;
  lastSyncAt: number | null;
  connectedAt: number | null;
}

export class DndAuthError extends Error {}

/* ---------------- stored connection ---------------- */

export async function getDndAuth(db: Db): Promise<DndAuth | null> {
  const row = await db.select().from(appMeta).where(eq(appMeta.key, AUTH_KEY)).get();
  if (!row) return null;
  try {
    const a = JSON.parse(row.value) as DndAuth;
    return a && typeof a.refreshToken === "string" && a.refreshToken ? a : null;
  } catch {
    return null;
  }
}

async function saveDndAuth(db: Db, a: DndAuth): Promise<void> {
  const value = JSON.stringify(a);
  await db
    .insert(appMeta)
    .values({ key: AUTH_KEY, value })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: sql`excluded.value` } })
    .run();
}

export async function clearDndAuth(db: Db): Promise<void> {
  await db.delete(appMeta).where(eq(appMeta.key, AUTH_KEY)).run();
}

export async function dndStatus(db: Db): Promise<DndStatus> {
  const a = await getDndAuth(db);
  return {
    connected: !!a,
    user: a?.user ?? null,
    agents: a?.agents ?? [],
    lastError: a?.lastError ?? null,
    lastSyncAt: a?.lastSyncAt ?? null,
    connectedAt: a?.connectedAt ?? null,
  };
}

export function dndBaseUrl(s: AppSettings): string {
  return (s.dndBaseUrl || DND_DEFAULT_URL).replace(/\/+$/, "");
}

/** Written into the DND deal's notes, so a retry after a crash can find a deal that was already created. */
export function dndMarker(taskId: number, key: string): string {
  return `[לוז #${taskId}/${key}]`;
}

/* ---------------- lock: one sync (and one refresh) at a time ---------------- */

async function withLock<T>(db: Db, fn: () => Promise<T>): Promise<T | null> {
  const now = Date.now();
  const claimed = await db
    .insert(appMeta)
    .values({ key: LOCK_KEY, value: String(now) })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: sql`excluded.value` }, setWhere: sql`CAST(${appMeta.value} AS INTEGER) < ${now - LOCK_MS}` })
    .returning({ value: appMeta.value })
    .get();
  if (!claimed) return null;
  try {
    return await fn();
  } finally {
    await db.update(appMeta).set({ value: "0" }).where(eq(appMeta.key, LOCK_KEY)).run();
  }
}

/* ---------------- HTTP ---------------- */

function setCookies(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}

/** The rotated refresh cookie from a refresh/sign-in response (ignoring the "delete old path" cookie). */
function rotatedRefreshToken(res: Response): string | null {
  for (const c of setCookies(res)) {
    const m = /^dndcash_refresh=([^;]*)/.exec(c.trim());
    if (m && m[1] && !/max-age=0/i.test(c)) return m[1];
  }
  return null;
}

function jwtExp(token: string): number | null {
  try {
    const part = token.split(".")[1];
    const json = atob(part.replace(/-/g, "+").replace(/_/g, "/").padEnd(part.length + ((4 - (part.length % 4)) % 4), "="));
    const exp = (JSON.parse(json) as { exp?: number }).exp;
    return typeof exp === "number" ? exp * 1000 : null;
  } catch {
    return null;
  }
}

async function refreshAccess(base: string, a: DndAuth): Promise<void> {
  const res = await fetch(`${base}/api/auth/refresh`, {
    method: "POST",
    headers: { cookie: `dndcash_refresh=${a.refreshToken}`, "content-type": "application/json", origin: base, "user-agent": UA },
    body: "{}",
  });
  const rotated = rotatedRefreshToken(res);
  if (rotated) a.refreshToken = rotated; // the old value is already dead – keep the new one no matter what follows
  if (!res.ok) throw new DndAuthError(`DND CASH refresh failed (${res.status})`);
  const data = (await res.json().catch(() => ({}))) as { accessToken?: string; user?: DndAuth["user"] };
  if (!data.accessToken) throw new DndAuthError("DND CASH refresh: no access token");
  a.accessToken = data.accessToken;
  a.accessExp = jwtExp(data.accessToken) ?? Date.now() + 14 * 60 * 1000;
  if (data.user) a.user = data.user;
  a.lastError = null;
}

/** A valid access token, refreshing (and persisting the rotated refresh token) when needed. Call under the lock. */
async function ensureAccess(db: Db, base: string, a: DndAuth): Promise<string> {
  if (a.accessToken && a.accessExp && a.accessExp - Date.now() > 60 * 1000) return a.accessToken;
  try {
    await refreshAccess(base, a);
  } finally {
    await saveDndAuth(db, a);
  }
  return a.accessToken as string;
}

async function dndRequest(base: string, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; data: Record<string, unknown> | null }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", origin: base, "user-agent": UA },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, data };
}

async function fetchAgents(base: string, token: string): Promise<DndAgent[]> {
  const r = await dndRequest(base, token, "GET", "/api/agents?isActive=true");
  if (r.status === 401) throw new DndAuthError("DND CASH: unauthorized");
  if (r.status !== 200 || !r.data) throw new Error(`DND CASH agents ${r.status}`);
  const items = (r.data.items as Record<string, unknown>[] | undefined) ?? [];
  return items.map((i) => ({
    id: String(i.id),
    email: typeof i.email === "string" ? i.email : null,
    displayName: typeof i.displayName === "string" ? i.displayName : String(i.id),
    isActive: i.isActive !== false && !i.deletedAt,
  }));
}

/* ---------------- connect / test ---------------- */

/** First-time connection with a refresh token obtained by signing in to DND CASH as the owner. */
export async function dndConnect(env: Env, db: Db, refreshToken: string): Promise<DndStatus> {
  const result = await withLock(db, async () => {
    const s = await getSettings(db, env);
    const base = dndBaseUrl(s);
    const a: DndAuth = { refreshToken: refreshToken.trim(), connectedAt: Date.now() };
    await ensureAccess(db, base, a);
    const me = await dndRequest(base, a.accessToken as string, "GET", "/api/auth/me");
    if (me.status !== 200 || !me.data) throw new Error(`DND CASH: התחברות נכשלה (${me.status})`);
    a.user = { displayName: String(me.data.displayName ?? ""), role: String(me.data.role ?? ""), email: typeof me.data.email === "string" ? me.data.email : undefined };
    a.agents = await fetchAgents(base, a.accessToken as string);
    a.agentsAt = Date.now();
    await saveDndAuth(db, a);
    return dndStatus(db);
  });
  if (!result) throw new Error("סנכרון ל-DND CASH רץ ברגע זה. נסה שוב בעוד רגע.");
  return result;
}

/** Re-check the stored connection: refresh, who am I, which agents exist. */
export async function dndTest(env: Env, db: Db): Promise<DndStatus> {
  const result = await withLock(db, async () => {
    const a = await getDndAuth(db);
    if (!a) throw new Error("DND CASH לא מחובר");
    const s = await getSettings(db, env);
    const base = dndBaseUrl(s);
    try {
      const token = await ensureAccess(db, base, a);
      const me = await dndRequest(base, token, "GET", "/api/auth/me");
      if (me.status !== 200 || !me.data) throw new Error(`DND CASH: בדיקה נכשלה (${me.status})`);
      a.user = { displayName: String(me.data.displayName ?? ""), role: String(me.data.role ?? ""), email: typeof me.data.email === "string" ? me.data.email : undefined };
      a.agents = await fetchAgents(base, token);
      a.agentsAt = Date.now();
      a.lastError = null;
      await saveDndAuth(db, a);
    } catch (e) {
      a.lastError = (e as Error).message;
      a.lastErrorAt = Date.now();
      await saveDndAuth(db, a);
      throw e;
    }
    return dndStatus(db);
  });
  if (!result) throw new Error("סנכרון ל-DND CASH רץ ברגע זה. נסה שוב בעוד רגע.");
  return result;
}

/* ---------------- deals ---------------- */

export function agentIdFor(email: string | null | undefined, agents: DndAgent[]): string | null {
  if (!email) return null;
  const e = email.trim().toLowerCase();
  return agents.find((a) => a.isActive && (a.email ?? "").trim().toLowerCase() === e)?.id ?? null;
}

export function dndPayload(deal: Deal, task: { id: number; dueDate: string; title: string }, assigneeName: string, agentId: string | null): Record<string, unknown> {
  const p: Record<string, unknown> = {
    clientName: deal.name,
    totalAmount: deal.amount,
    dealType: deal.plusTraining ? "SALES_PLUS_TRAINING" : "SALES_ONLY",
    paymentMethod: deal.method ? DND_PAYMENT_METHOD[deal.method] : undefined,
    agentId,
    // DND CASH's own form sends the closing date as a full timestamp (midnight UTC), not a bare date.
    closedAt: `${task.dueDate}T00:00:00.000Z`,
    notes: `${dndMarker(task.id, deal.key ?? "")} מלו"ז יומי · ${assigneeName} · ${task.title}`.slice(0, 500),
  };
  if (isStandingOrder(deal.method)) {
    p.standingOrderMonths = deal.months;
    p.firstDueDate = deal.firstDue || task.dueDate;
    if (deal.upfront && deal.upfront > 0) p.upfrontAmount = deal.upfront;
  }
  return p;
}

const ERROR_HE: Record<string, string> = {
  INVALID_STANDING_ORDER_MONTHS: "מספר החודשים לא תקין",
  INVALID_TOTAL_AMOUNT: "הסכום לא תקין",
  INVALID_UPFRONT_AMOUNT: "סכום המקדמה לא תקין",
  MISSING_CLOSED_AT: "חסר תאריך סגירה",
  DEAL_MISSING_TYPE: "חסר סוג עסקה",
  AGENT_NOT_FOUND: "הסוכן לא נמצא ב-DND CASH",
  AGENT_INACTIVE: "הסוכן לא פעיל ב-DND CASH",
};

function describeError(status: number, data: Record<string, unknown> | null): string {
  const code = typeof data?.error === "string" ? data.error : typeof data?.message === "string" ? data.message : "";
  if (ERROR_HE[code]) return ERROR_HE[code];
  // Unknown answer: keep what DND CASH actually said, so the reason can be read on the deal.
  const raw = data ? JSON.stringify(data).slice(0, 240) : "";
  return `DND CASH ${status}${code ? `: ${code}` : ""}${raw && raw !== `{"error":"${code}"}` && raw !== `{"message":"${code}"}` ? ` · ${raw}` : ""}`;
}

/** After a failed attempt the deal may already exist in DND CASH: look for our marker on that day. */
async function findExisting(base: string, token: string, taskId: number, key: string, closedAt: string, name: string): Promise<string | null> {
  const r = await dndRequest(base, token, "GET", `/api/deals?page=1&pageSize=100&from=${closedAt}&to=${closedAt}&search=${encodeURIComponent(name)}`);
  if (r.status === 401) throw new DndAuthError("DND CASH: unauthorized");
  if (r.status !== 200 || !r.data) return null;
  const marker = dndMarker(taskId, key);
  const items = (r.data.items as Record<string, unknown>[] | undefined) ?? [];
  const hit = items.find((i) => typeof i.notes === "string" && i.notes.includes(marker));
  return hit ? String(hit.id) : null;
}

/** Write the sync state back onto the task's deals, matching by key so a concurrent edit is not lost. */
async function writeDealState(db: Db, taskId: number, synced: Deal[]): Promise<void> {
  const cur = await db.select({ dealsJson: tasks.dealsJson }).from(tasks).where(eq(tasks.id, taskId)).get();
  const latest = parseDeals(cur?.dealsJson ?? null);
  const byKey = new Map(synced.filter((d) => d.key).map((d) => [d.key as string, d.dnd]));
  const merged = latest.map((d) => (d.key && byKey.has(d.key) ? { ...d, dnd: byKey.get(d.key) } : d));
  await db.update(tasks).set({ dealsJson: JSON.stringify(merged) }).where(eq(tasks.id, taskId)).run();
}

async function failAuth(env: Env, db: Db, a: DndAuth, e: Error): Promise<void> {
  const now = Date.now();
  a.lastError = e.message;
  a.lastErrorAt = now;
  a.accessToken = undefined;
  a.accessExp = undefined;
  if (!a.alertedAt || now - a.alertedAt > ALERT_EVERY_MS) {
    a.alertedAt = now;
    const admins = await db.select().from(users).where(and(eq(users.role, "admin"), eq(users.active, 1))).all();
    for (const u of admins) {
      try {
        await notifyUser(env, db, u.id, {
          title: "⚠️ החיבור ל-DND CASH נפל",
          body: "נסלקים חדשים לא נשלחים ל-DND CASH. צריך להתחבר מחדש במסך ההגדרות.",
          url: `${env.APP_URL || ""}/settings`,
          tag: "dnd-auth",
        });
      } catch (err) {
        console.error("dnd alert failed", err);
      }
    }
  }
  await saveDndAuth(db, a);
}

export interface DndSyncResult {
  sent: number;
  failed: number;
  pending: number;
}

/**
 * Send every deal that is still marked "pending" to DND CASH. Runs from the cron and right after a deal is saved;
 * the lock keeps it to one runner at a time (which also protects the rotating refresh token).
 */
export async function syncDndDeals(env: Env, db: Db, opts: { retryErrors?: boolean } = {}): Promise<DndSyncResult | null> {
  return withLock(db, async () => {
    const result: DndSyncResult = { sent: 0, failed: 0, pending: 0 };
    const a = await getDndAuth(db);
    if (!a) return result;
    // The cron sends what is pending; "sync now" from the settings screen also gives rejected deals another go.
    const where = opts.retryErrors
      ? or(like(tasks.dealsJson, '%"status":"pending"%'), like(tasks.dealsJson, '%"status":"error"%'))
      : like(tasks.dealsJson, '%"status":"pending"%');
    const rows = await db
      .select()
      .from(tasks)
      .where(and(isNull(tasks.deletedAt), where))
      .limit(50)
      .all();
    if (rows.length === 0) return result;
    const s = await getSettings(db, env);
    const base = dndBaseUrl(s);
    let token: string;
    try {
      token = await ensureAccess(db, base, a);
      if (!a.agents || !a.agentsAt || Date.now() - a.agentsAt > AGENTS_TTL_MS) {
        a.agents = await fetchAgents(base, token);
        a.agentsAt = Date.now();
        await saveDndAuth(db, a);
      }
    } catch (e) {
      if (e instanceof DndAuthError) await failAuth(env, db, a, e);
      else console.error("dnd sync: setup failed", e);
      result.pending = rows.length;
      return result;
    }
    const team = await db.select().from(users).all();
    for (const row of rows) {
      const deals = parseDeals(row.dealsJson);
      const assignee = team.find((u) => u.id === row.assigneeId);
      const agentId = agentIdFor(assignee?.email, a.agents ?? []);
      let changed = false;
      let authFailed: DndAuthError | null = null;
      for (const d of deals) {
        if (!d.dnd || !d.key) continue;
        if (d.dnd.status !== "pending" && !(opts.retryErrors && d.dnd.status === "error")) continue;
        const attempts = d.dnd.attempts ?? 0;
        if (attempts >= MAX_ATTEMPTS) {
          d.dnd = { ...d.dnd, status: "error", error: "יותר מדי ניסיונות. לבדוק ידנית ב-DND CASH." };
          changed = true;
          result.failed++;
          continue;
        }
        try {
          let id = attempts > 0 ? await findExisting(base, token, row.id, d.key, row.dueDate, d.name) : null;
          if (!id) {
            const r = await dndRequest(base, token, "POST", "/api/deals", dndPayload(d, row, assignee?.name ?? "", agentId));
            if (r.status === 401) throw new DndAuthError("DND CASH: unauthorized");
            if (r.status >= 200 && r.status < 300) id = r.data && r.data.id != null ? String(r.data.id) : null;
            else if (r.status >= 400 && r.status < 500) {
              d.dnd = { ...d.dnd, status: "error", error: describeError(r.status, r.data), attempts: attempts + 1 };
              changed = true;
              result.failed++;
              continue;
            } else throw new Error(`DND CASH ${r.status}`);
          }
          if (id) {
            d.dnd = { status: "sent", id, sentAt: nowIso(), attempts: attempts + 1 };
            result.sent++;
          } else {
            d.dnd = { ...d.dnd, attempts: attempts + 1, error: "DND CASH לא החזיר מזהה" };
            result.pending++;
          }
          changed = true;
        } catch (e) {
          if (e instanceof DndAuthError) {
            authFailed = e;
            break;
          }
          d.dnd = { ...d.dnd, attempts: attempts + 1, error: (e as Error).message };
          changed = true;
          result.pending++;
        }
      }
      if (changed) await writeDealState(db, row.id, deals);
      if (authFailed) {
        await failAuth(env, db, a, authFailed);
        result.pending += deals.filter((d) => d.dnd?.status === "pending").length;
        return result;
      }
    }
    a.lastSyncAt = Date.now();
    await saveDndAuth(db, a);
    return result;
  });
}

