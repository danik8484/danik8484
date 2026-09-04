import { and, eq, gt, lt, desc, sql } from "drizzle-orm";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import type { Context } from "hono";
import type { AppEnv } from "./context";
import type { Env } from "./env";
import { type Db } from "./db/client";
import { users, loginCodes, sessions } from "./db/schema";
import { sendLoginCode } from "./email";

const COOKIE = "sid";
const SESSION_DAYS = 60;
const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODES_PER_HOUR = 10;
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

export async function requestCode(db: Db, env: Env, email: string): Promise<RequestCodeResult> {
  const user = await findUserByEmail(db, env, email);
  // Do not reveal whether the email exists. Always respond ok.
  if (!user || !user.active) return { ok: true };

  const now = Date.now();
  const recent = await db
    .select({ n: sql<number>`count(*)` })
    .from(loginCodes)
    .where(and(eq(loginCodes.email, email), gt(loginCodes.createdAt, now - 60 * 60 * 1000)))
    .get();
  if ((recent?.n ?? 0) >= MAX_CODES_PER_HOUR) {
    return { ok: false, error: "יותר מדי בקשות. נסה שוב בעוד שעה.", status: 429 };
  }

  const code = randomCode();
  await db
    .insert(loginCodes)
    .values({ email, codeHash: await sha256(email + ":" + code), expiresAt: now + CODE_TTL_MS, createdAt: now })
    .run();
  await sendLoginCode(env, email, code);
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
  if (row.attempts >= MAX_ATTEMPTS) return { ok: false, error: "יותר מדי ניסיונות. בקש קוד חדש." };

  const hash = await sha256(email + ":" + code.trim());
  if (hash !== row.codeHash) {
    await db.update(loginCodes).set({ attempts: row.attempts + 1 }).where(eq(loginCodes.id, row.id)).run();
    return { ok: false, error: "קוד שגוי או שפג תוקפו" };
  }
  await db.update(loginCodes).set({ used: 1 }).where(eq(loginCodes.id, row.id)).run();
  // Cleanup old codes opportunistically
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
  if (id) await db.delete(sessions).where(eq(sessions.id, id)).run();
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
