import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { pushSubscriptions, notificationQueue } from "../db/schema";
import { getVapid, pushToUser } from "../push";
import { readJson, str } from "../validate";
import { getCookie } from "hono/cookie";
import { isNull, sql } from "drizzle-orm";

export const pushRoutes = new Hono<AppEnv>();

pushRoutes.get("/config", async (c) => {
  const vapid = await getVapid(c.get("db"));
  const row = await c
    .get("db")
    .select({ n: sql<number>`count(*)` })
    .from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, c.get("user").id))
    .get();
  return c.json({ publicKey: vapid.publicKey, devices: Number(row?.n ?? 0) });
});

pushRoutes.post("/subscribe", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const body = await readJson(c.req.raw);
  const endpoint = str(body.endpoint, 2000);
  const keys = (body.keys ?? {}) as Record<string, unknown>;
  const p256dh = str(keys.p256dh, 300);
  const auth = str(keys.auth, 100);
  if (!endpoint || !endpoint.startsWith("https://") || !p256dh || !auth) return c.json({ error: "מנוי התראות לא תקין" }, 400);
  const ua = (c.req.header("user-agent") || "").slice(0, 200);
  const sessionId = getCookie(c, "sid") ?? null;
  // A browser endpoint belongs to whoever is signed in on that device now (shared phones/tablets).
  await db
    .insert(pushSubscriptions)
    .values({ userId: me.id, endpoint, p256dh, auth, userAgent: ua, sessionId })
    .onConflictDoUpdate({ target: pushSubscriptions.endpoint, set: { userId: me.id, p256dh, auth, userAgent: ua, sessionId, failures: 0, lastError: null } })
    .run();
  return c.json({ ok: true });
});

pushRoutes.post("/unsubscribe", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const body = await readJson(c.req.raw);
  const endpoint = str(body.endpoint, 2000);
  if (!endpoint) return c.json({ error: "חסר endpoint" }, 400);
  await db.delete(pushSubscriptions).where(and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, me.id))).run();
  return c.json({ ok: true });
});

/** Send a test notification to the caller's own devices. */
pushRoutes.post("/test", async (c) => {
  const me = c.get("user");
  const origin = new URL(c.req.url).origin;
  const n = await pushToUser(c.env, c.get("db"), me.id, { title: "ההתראות פועלות ✓", body: `היי ${me.name}, ככה תיראה התראה על משימה חדשה.`, url: origin + "/", tag: "test" });
  return c.json({ ok: true, delivered: n });
});

/** How many "new task" notices are waiting to be sent to me (used by tests / debugging). */
pushRoutes.get("/pending", async (c) => {
  const row = await c
    .get("db")
    .select({ n: sql<number>`count(*)` })
    .from(notificationQueue)
    .where(and(eq(notificationQueue.userId, c.get("user").id), isNull(notificationQueue.sentAt)))
    .get();
  return c.json({ pending: Number(row?.n ?? 0) });
});
