import { and, eq, gt, lt, desc, sql, isNull } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv } from "./context";
import type { Env } from "./env";
import { type Db } from "./db/client";
import { users, loginCodes, loginLinks, sessions, pushSubscriptions } from "./db/schema";
import { EmailNotConfigured, sendLoginCode } from "./email";

const COOKIE = "sid";
const SESSION_DAYS = 60;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODES_PER_HOUR = 20;
const MAX_ATTEMPTS = 5;

export function normalizeEmail(e: unknown): string | null {
  if (typeof e !== "string") return null;
  const v = e.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v) || v.length > 200) return null;
  return v;
}

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(arr[0] % 1_000_000).padStart(6, "0");
}

function randomId(): string {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Find the user for an email; bootstrap the admin with ADMIN_EMAIL on first use. */
export async function findUserByEmail(db: Db, env: Env, email: string) {
  const existing = await db.select().from(users).where(eq(users.email, email)).get();
  if (existing) return existing;
  const adminEmail = env.ADMIN_EMAIL?.trim().toLowerCase();
  if (adminEmail && adminEmail === email) {
    const admin = await db.select().from(users).where(eq(users.role, "admin")).orderBy(users.id).get();
    if (admin && !admin.email) {
      await db.update(users).set({ email }).where(eq(users.id, admin.id)).run();
      return { ...admin, email };
    }
  }
  return null;
}

export type RequestCodeResult = { ok: true; devCode?: string } | { ok: false; error: string; status: number };

/** Create a fresh code for an identifier ("email" or "user:<id>"), enforcing the hourly limit. */
export async function issueCode(db: Db, key: string): Promise<{ ok: true; code: string } | { ok: false; error: string; status: number }> {
  const now = Date.now();
  const recent = await db
    .select({ n: sql<number>`count(*)` })
    .from(loginCodes)
    .where(and(eq(loginCodes.email, key), gt(loginCodes.createdAt, now - 60 * 60 * 1000)))
    .get();
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) return { ok: false, error: "יותר מדי בקשות. נסה שוב בעוד שעה.", status: 429 };
  const code = randomCode();
  await db.insert(loginCodes).values({ email: key, codeHash: await sha256(key + ":" + code), expiresAt: now + CODE_TTL_MS, createdAt: now }).run();
  return { ok: true, code };
}

/** Check a code for an identifier: atomic attempt cap, single use. */
export async function checkCode(db: Db, key: string, code: string): Promise<boolean> {
  const now = Date.now();
  const row = await db
    .select()
    .from(loginCodes)
    .where(and(eq(loginCodes.email, key), eq(loginCodes.used, 0), gt(loginCodes.expiresAt, now)))
    .orderBy(desc(loginCodes.createdAt))
    .get();
  if (!row) return false;
  const bumped = await db
    .update(loginCodes)
    .set({ attempts: sql`${loginCodes.attempts} + 1` })
    .where(and(eq(loginCodes.id, row.id), lt(loginCodes.attempts, MAX_ATTEMPTS)))
    .returning({ id: loginCodes.id })
    .get();
  if (!bumped) return false;
  if ((await sha256(key + ":" + code.trim())) !== row.codeHash) return false;
  const consumed = await db.update(loginCodes).set({ used: 1 }).where(and(eq(loginCodes.id, row.id), eq(loginCodes.used, 0))).returning({ id: loginCodes.id }).get();
  if (!consumed) return false;
  await db.delete(loginCodes).where(lt(loginCodes.expiresAt, now - 24 * 60 * 60 * 1000)).run();
  return true;
}

export async function requestCode(db: Db, env: Env, email: string): Promise<RequestCodeResult> {
  const now = Date.now();
  // Rate limit first, for every address alike, so the response cannot reveal whether an address is registered.
  const recent = await db
    .select({ n: sql<number>`count(*)` })
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), gt(loginCodes.createdAt, now - 60 * 60 * 1000)))
    .get();
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) {
    return { ok: false, error: "יותר מדי בקשות. נסה שוב בעוד שעה.", status: 429 };
  }
  const user = await findUserByEmail(db, env, email);
  if (!user || !user.active) {
    // Unknown address: record the attempt (counts toward the limit) and answer exactly like a real one.
    await db.insert(loginCodes).values({ email, codeHash: "-", expiresAt: now, used: 1, createdAt: now }).run();
    return { ok: true };
  }

  const code = randomCode();
  await db
    .insert(loginCodes)
    .values({ email, codeHash: await sha256(email + ":" + code), expiresAt: now + CODE_TTL_MS, createdAt: now })
    .run();
  try {
    await sendLoginCode(env, email, code);
  } catch (e) {
    if (e instanceof EmailNotConfigured) {
      console.error("login code requested but email sending is not configured");
      return { ok: true };
    }
    throw e;
  }
  return { ok: true, devCode: env.APP_ENV === "development" ? code : undefined };
}

export async function verifyCode(db: Db, env: Env, email: string, code: string): Promise<{ ok: true; userId: number } | { ok: false; error: string }> {
  const user = await findUserByEmail(db, env, email);
  if (!user || !user.active) return { ok: false, error: "קוד שגוי או שפג תוקפו" };
  const now = Date.now();
  const row = await db
    .select()
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), eq(loginCodes.used, 0), gt(loginCodes.expiresAt, now)))
    .orderBy(desc(loginCodes.createdAt))
    .get();
  if (!row) return { ok: false, error: "קוד שגוי או שפג תוקפו" };

  // Atomic attempt counter: parallel guesses cannot slip past the cap.
  const bumped = await db
    .update(loginCodes)
    .set({ attempts: sql`${loginCodes.attempts} + 1` })
    .where(and(eq(loginCodes.id, row.id), lt(loginCodes.attempts, MAX_ATTEMPTS)))
    .returning({ id: loginCodes.id })
    .get();
  if (!bumped) return { ok: false, error: "יותר מדי ניסיונות. בקש קוד חדש." };

  const hash = await sha256(email + ":" + code.trim());
  if (hash !== row.codeHash) return { ok: false, error: "קוד שגוי או שפג תוקפו" };
  // Single use, atomically
  const consumed = await db.update(loginCodes).set({ used: 1 }).where(and(eq(loginCodes.id, row.id), eq(loginCodes.used, 0))).returning({ id: loginCodes.id }).get();
  if (!consumed) return { ok: false, error: "קוד שגוי או שפג תוקפו" };
  await db.delete(loginCodes).where(lt(loginCodes.expiresAt, now - 24 * 60 * 60 * 1000)).run();
  return { ok: true, userId: user.id };
}

export async function createSession(c: Context<AppEnv>, db: Db, userId: number) {
  const id = randomId();
  const now = Date.now();
  const expiresAt = now + SESSION_DAYS * 24 * 60 * 60 * 1000;
  await db.insert(sessions).values({ id, userId, createdAt: now, expiresAt }).run();
  await db.delete(sessions).where(lt(sessions.expiresAt, now)).run();
  setCookie(c, COOKIE, id, {
    httpOnly: true,
    sameSite: "Lax",
    secure: c.env.APP_ENV !== "development",
    path: "/",
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  });
}

export async function destroySession(c: Context<AppEnv>, db: Db) {
  const id = getCookie(c, COOKIE);
  if (id) {
    await db.delete(sessions).where(eq(sessions.id, id)).run();
    // Devices registered under this session stop receiving this user's notifications.
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.sessionId, id)).run();
  }
  deleteCookie(c, COOKIE, { path: "/" });
}

export async function getSessionUser(c: Context<AppEnv>, db: Db) {
  const id = getCookie(c, COOKIE);
  if (!id) return null;
  const row = await db
    .select({ user: users, expiresAt: sessions.expiresAt })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, Date.now())))
    .get();
  if (!row || !row.user.active) return null;
  return row.user;
}

const LINK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** One-time sign-in link an admin can send by WhatsApp. Valid 7 days, single use. */
export async function createLoginLink(db: Db, userId: number, createdById: number | null): Promise<{ token: string; expiresAt: number }> {
  const token = randomId();
  const now = Date.now();
  const expiresAt = now + LINK_TTL_MS;
  await db.insert(loginLinks).values({ tokenHash: await sha256("link:" + token), userId, createdById, expiresAt, createdAt: now }).run();
  return { token, expiresAt };
}

export async function redeemLoginLink(db: Db, token: string): Promise<{ ok: true; userId: number } | { ok: false; error: string }> {
  if (!/^[0-9a-f]{64}$/.test(token)) return { ok: false, error: "הקישור אינו תקין" };
  const now = Date.now();
  const row = await db.select().from(loginLinks).where(eq(loginLinks.tokenHash, await sha256("link:" + token))).get();
  if (!row) return { ok: false, error: "הקישור אינו תקין" };
  if (row.usedAt) return { ok: false, error: "הקישור כבר נוצל. בקש קישור חדש." };
  if (row.expiresAt < now) return { ok: false, error: "פג תוקף הקישור. בקש קישור חדש." };
  const user = await db.select().from(users).where(eq(users.id, row.userId)).get();
  if (!user || !user.active) return { ok: false, error: "המשתמש אינו פעיל" };
  // Single use, atomically (two simultaneous clicks cannot both sign in)
  const claimed = await db.update(loginLinks).set({ usedAt: now }).where(and(eq(loginLinks.id, row.id), isNull(loginLinks.usedAt))).returning({ id: loginLinks.id }).get();
  if (!claimed) return { ok: false, error: "הקישור כבר נוצל. בקש קישור חדש." };
  return { ok: true, userId: user.id };
}
