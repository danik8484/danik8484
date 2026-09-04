import { Hono } from "hono";
import type { AppEnv } from "../context";
import { normalizeEmail, requestCode, verifyCode, createSession, destroySession, redeemLoginLink } from "../auth";
import { readJson } from "../validate";

export const authRoutes = new Hono<AppEnv>();

authRoutes.post("/request-code", async (c) => {
  const body = await readJson(c.req.raw);
  const email = normalizeEmail(body.email);
  if (!email) return c.json({ error: "כתובת מייל לא תקינה" }, 400);
  const res = await requestCode(c.get("db"), c.env, email);
  if (!res.ok) return c.json({ error: res.error }, res.status as 429 | 503);
  return c.json({ ok: true, devCode: res.devCode });
});

authRoutes.post("/verify", async (c) => {
  const body = await readJson(c.req.raw);
  const email = normalizeEmail(body.email);
  const code = typeof body.code === "string" ? body.code.replace(/\D/g, "") : "";
  if (!email || code.length !== 6) return c.json({ error: "קוד שגוי או שפג תוקפו" }, 400);
  const res = await verifyCode(c.get("db"), c.env, email, code);
  if (!res.ok) return c.json({ error: res.error }, 401);
  await createSession(c, c.get("db"), res.userId);
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
