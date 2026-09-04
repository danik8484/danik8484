import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppEnv } from "../context";
import { users, sessions, pushSubscriptions, notificationQueue } from "../db/schema";
import { and, isNull } from "drizzle-orm";
import { materializeRecurring } from "../recurring";
import { localDate } from "../dates";
import { toPublicUser } from "../serialize";
import { createLoginLink, normalizeEmail } from "../auth";
import { int, phone as parsePhone, readJson, str } from "../validate";
import type { Role } from "@shared/types";

export const userRoutes = new Hono<AppEnv>();

const ROLES: Role[] = ["admin", "manager", "employee"];

userRoutes.use("*", async (c, next) => {
  if (c.get("user").role !== "admin") return c.json({ error: "רק מנהל ראשי יכול לנהל אנשי צוות" }, 403);
  await next();
});

userRoutes.get("/", async (c) => {
  return c.json({ users: c.get("team").map((u) => toPublicUser(u, true)) });
});

function validateManager(role: Role, managerId: number | null, team: { id: number; role: string; active: number }[], selfId: number | null): string | null {
  if (role === "admin") return null;
  if (managerId === null) return "חובה לבחור מנהל";
  if (managerId === selfId) return "איש צוות לא יכול להיות מנהל של עצמו";
  const m = team.find((u) => u.id === managerId);
  if (!m || m.active !== 1) return "מנהל לא תקין";
  if (m.role === "employee") return "מנהל חייב להיות בתפקיד מנהל או מנהל ראשי";
  return null;
}

userRoutes.post("/", async (c) => {
  const db = c.get("db");
  const team = c.get("team");
  const body = await readJson(c.req.raw);
  const name = str(body.name, 100);
  const role = body.role as Role;
  const managerId = body.managerId === null || body.managerId === undefined || body.managerId === "" ? null : int(body.managerId);
  const email = body.email ? normalizeEmail(body.email) : null;
  const phone = parsePhone(body.phone);
  if (phone === undefined && body.phone !== undefined) return c.json({ error: "מספר טלפון לא תקין" }, 400);
  if (!name) return c.json({ error: "חובה להזין שם" }, 400);
  if (!ROLES.includes(role)) return c.json({ error: "תפקיד לא תקין" }, 400);
  if (body.email && !email) return c.json({ error: "כתובת מייל לא תקינה" }, 400);
  const err = validateManager(role, managerId, team, null);
  if (err) return c.json({ error: err }, 400);
  if (email && team.some((u) => u.email === email)) return c.json({ error: "המייל כבר בשימוש" }, 409);
  const maxSort = Math.max(0, ...team.map((u) => u.sortOrder));
  const row = await db
    .insert(users)
    .values({ name, email, phone: phone ?? null, role, managerId: role === "admin" ? null : managerId, sortOrder: maxSort + 1 })
    .returning()
    .get();
  return c.json({ ok: true, user: toPublicUser(row, true) }, 201);
});

userRoutes.patch("/:id", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const team = c.get("team");
  const id = int(c.req.param("id"));
  const body = await readJson(c.req.raw);
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = team.find((u) => u.id === id);
  if (!row) return c.json({ error: "לא נמצא" }, 404);

  const patch: Partial<typeof users.$inferInsert> = {};
  if (body.name !== undefined) {
    const name = str(body.name, 100);
    if (!name) return c.json({ error: "חובה להזין שם" }, 400);
    patch.name = name;
  }
  if (body.email !== undefined) {
    if (body.email === null || body.email === "") patch.email = null;
    else {
      const email = normalizeEmail(body.email);
      if (!email) return c.json({ error: "כתובת מייל לא תקינה" }, 400);
      if (team.some((u) => u.email === email && u.id !== id)) return c.json({ error: "המייל כבר בשימוש" }, 409);
      patch.email = email;
    }
  }
  if (body.phone !== undefined) {
    const phone = parsePhone(body.phone);
    if (phone === undefined) return c.json({ error: "מספר טלפון לא תקין" }, 400);
    patch.phone = phone;
  }
  const role = (body.role !== undefined ? body.role : row.role) as Role;
  if (!ROLES.includes(role)) return c.json({ error: "תפקיד לא תקין" }, 400);
  if (id === me.id && role !== "admin") return c.json({ error: "לא ניתן לשנות את התפקיד של עצמך" }, 400);
  const managerId = body.managerId !== undefined ? (body.managerId === null || body.managerId === "" ? null : int(body.managerId)) : row.managerId;
  if (role !== "admin") {
    const err = validateManager(role, managerId, team, id);
    if (err) return c.json({ error: err }, 400);
  }
  patch.role = role;
  patch.managerId = role === "admin" ? null : managerId;
  const reports = team.filter((u) => u.managerId === id && u.active === 1 && u.id !== id);
  if (role === "employee" && reports.length > 0) {
    return c.json({ error: `לא ניתן להפוך לאיש צוות: ${reports.map((u) => u.name).join(", ")} עדיין תחת ניהולו. קודם העבר אותם למנהל אחר.` }, 400);
  }
  if (body.active !== undefined) {
    if (id === me.id && !body.active) return c.json({ error: "לא ניתן להשבית את עצמך" }, 400);
    if (!body.active && reports.length > 0) {
      return c.json({ error: `לא ניתן להשבית: ${reports.map((u) => u.name).join(", ")} עדיין תחת ניהולו. קודם העבר אותם למנהל אחר.` }, 400);
    }
    patch.active = body.active ? 1 : 0;
  }
  if (body.sortOrder !== undefined) {
    const so = int(body.sortOrder);
    if (so !== null) patch.sortOrder = so;
  }
  await db.update(users).set(patch).where(eq(users.id, id)).run();
  if (patch.active === 0) {
    await db.delete(sessions).where(eq(sessions.userId, id)).run();
    await db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, id)).run();
    await db.delete(notificationQueue).where(and(eq(notificationQueue.userId, id), isNull(notificationQueue.sentAt))).run();
  }
  if (patch.active === 1 && row.active === 0) await materializeRecurring(db, localDate(c.env.TIMEZONE), true);
  const updated = await db.select().from(users).where(eq(users.id, id)).get();
  return c.json({ ok: true, user: toPublicUser(updated!, true) });
});

/** Admin: one-time sign-in link for a teammate (e.g. to send by WhatsApp). */
userRoutes.post("/:id/login-link", async (c) => {
  const id = int(c.req.param("id"));
  const target = c.get("team").find((u) => u.id === id);
  if (id === null || !target) return c.json({ error: "לא נמצא" }, 404);
  if (target.active !== 1) return c.json({ error: "המשתמש מושבת" }, 400);
  const { token, expiresAt } = await createLoginLink(c.get("db"), id, c.get("user").id);
  const url = new URL(c.req.url);
  return c.json({ ok: true, url: `${url.origin}/login?t=${token}`, expiresAt });
});
