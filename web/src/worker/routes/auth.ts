import { Hono } from "hono";
import type { AppEnv } from "../context";
import { normalizeEmail, requestCode, verifyCode, createSession, destroySession, redeemLoginLink, issueCode, checkCode } from "../auth";
import { users } from "../db/schema";
import { and, asc, eq } from "drizzle-orm";
import { getSettings } from "../settings";
import { sendWhatsAppCode, whatsappConfigured } from "../whatsapp";
import { int } from "../validate";
import type { AuthConfig } from "@shared/types";
import { readJson } from "../validate";

export const authRoutes = new Hono<AppEnv>();

/** Public: the team list for the "pick your name" login, and which code channels exist. */
authRoutes.get("/config", async (c) => {
  const db = c.get("db");
  const team = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.active, 1)).orderBy(asc(users.sortOrder), asc(users.id)).all();
  const s = await getSettings(db, c.env);
  const res: AuthConfig = { team, whatsapp: whatsappConfigured(s) || c.env.APP_ENV === "development", email: !!(c.env.BREVO_API_KEY && c.env.MAIL_FROM) || c.env.APP_ENV === "development" };
  return c.json(res);
});

/** Pick a name → a one-time code goes to the phone linked to that team member (WhatsApp). */
authRoutes.post("/request-code", async (c) => {
  const db = c.get("db");
  const body = await readJson(c.req.raw);
  if (body.userId !== undefined) {
    const userId = int(body.userId);
    const user = userId === null ? undefined : await db.select().from(users).where(and(eq(users.id, userId), eq(users.active, 1))).get();
    if (!user) return c.json({ error: "איש צוות לא נמצא" }, 404);
    const issued = await issueCode(db, `user:${user.id}`);
    if (!issued.ok) return c.json({ error: issued.error }, issued.status as 429);
    const s = await getSettings(db, c.env);
    if (user.phone && whatsappConfigured(s)) {
      try {
        await sendWhatsAppCode(s, user.phone, issued.code);
      } catch (e) {
        console.error("whatsapp code failed", e);
        return c.json({ error: "שליחת הקוד לוואטסאפ נכשלה. נסה שוב או בקש מהמנהל קישור כניסה." }, 502);
      }
    } else if (c.env.APP_ENV !== "development") {
      return c.json({ error: !user.phone ? "לא מוגדר מספר טלפון לאיש הצוות הזה. בקש מהמנהל להוסיף אותו, או קישור כניסה." : "שליחת קודים בוואטסאפ עדיין לא הופעלה. בקש מהמנהל קישור כניסה." }, 503);
    }
    const masked = user.phone ? `•••${user.phone.slice(-4)}` : "";
    return c.json({ ok: true, to: masked, devCode: c.env.APP_ENV === "development" ? issued.code : undefined });
  }
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: "כתובת מייל לא תקינה" }, 400);
  const res = await requestCode(db, c.env, email);
  if (!res.ok) return c.json({ error: res.error }, res.status as 429);
  return c.json({ ok: true, devCode: res.devCode });
});

authRoutes.post("/verify", async (c) => {
  const db = c.get("db");
  const body = await readJson(c.req.raw);
  const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
  if (code.length !== 6) return c.json({ error: "קוד שגוי או שפג תוקפו" }, 400);
  if (body.userId !== undefined) {
    const userId = int(body.userId);
    const user = userId === null ? undefined : await db.select().from(users).where(and(eq(users.id, userId), eq(users.active, 1))).get();
    if (!user || !(await checkCode(db, `user:${user.id}`, code))) return c.json({ error: "קוד שגוי או שפג תוקפו" }, 401);
    await createSession(c, db, user.id);
    return c.json({ ok: true });
  }
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: "קוד שגוי או שפג תוקפו" }, 400);
  const res = await verifyCode(db, c.env, email, code);
  if (!res.ok) return c.json({ error: res.error }, 401);
  await createSession(c, db, res.userId);
  return c.json({ ok: true });
});

authRoutes.post("/link", async (c) => {
  const body = await readJson(c.req.raw);
  const token = typeof body.token === "string" ? body.token.trim() : "";
  const res = await redeemLoginLink(c.get("db"), token);
  if (!res.ok) return c.json({ error: res.error }, 401);
  await createSession(c, c.get("db"), res.userId);
  return c.json({ ok: true });
});

authRoutes.post("/logout", async (c) => {
  await destroySession(c, c.get("db"));
  return c.json({ ok: true });
});
