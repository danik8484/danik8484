import { Hono } from "hono";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { AppEnv } from "../context";
import { recurringTasks } from "../db/schema";
import { toRecurring, toPublicUser } from "../serialize";
import { visibleIdsFor } from "../team";
import { canEditOrDelete, canManage } from "@shared/permissions";
import { int, readJson, str, weekdays as parseWeekdays } from "../validate";
import { localDate, nowIso } from "../dates";
import { materializeRecurring } from "../recurring";

export const recurringRoutes = new Hono<AppEnv>();

recurringRoutes.get("/", async (c) => {
  const db = c.get("db");
  const visible = visibleIdsFor(c.get("user"), c.get("team"));
  if (visible.length === 0) return c.json({ recurring: [] });
  const rows = await db
    .select()
    .from(recurringTasks)
    .where(and(isNull(recurringTasks.deletedAt), inArray(recurringTasks.assigneeId, visible)))
    .orderBy(asc(recurringTasks.assigneeId), asc(recurringTasks.id))
    .all();
  return c.json({ recurring: rows.map(toRecurring) });
});

recurringRoutes.patch("/:id", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const teamPublic = c.get("teamPublic");
  const id = int(c.req.param("id"));
  const body = await readJson(c.req.raw);
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = await db.select().from(recurringTasks).where(and(eq(recurringTasks.id, id), isNull(recurringTasks.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  const mePublic = toPublicUser(me, false);
  if (!canManage(mePublic, row.assigneeId, teamPublic)) return c.json({ error: "אין הרשאה" }, 403);
  if (!canEditOrDelete(mePublic, row, teamPublic)) return c.json({ error: "רק מי שהוסיף את המשימה (או המנהל) יכול לערוך אותה" }, 403);

  const patch: Partial<typeof recurringTasks.$inferInsert> = {};
  if (body.title !== undefined) {
    const title = str(body.title, 200);
    if (!title) return c.json({ error: "חובה להזין שם משימה" }, 400);
    patch.title = title;
  }
  if (body.details !== undefined) {
    const details = str(body.details, 3000, { required: false });
    if (details === null) return c.json({ error: "הפירוט ארוך מדי" }, 400);
    patch.details = details;
  }
  if (body.weekdays !== undefined) {
    const wds = parseWeekdays(body.weekdays);
    if (!wds || wds.length === 0) return c.json({ error: "יש לבחור לפחות יום אחד" }, 400);
    patch.weekdays = wds.join(",");
  }
  if (body.active !== undefined) patch.active = body.active ? 1 : 0;
  if (body.kind !== undefined) patch.kind = body.kind === "leads" ? "leads" : "normal";
  await db.update(recurringTasks).set(patch).where(eq(recurringTasks.id, id)).run();
  const updated = await db.select().from(recurringTasks).where(eq(recurringTasks.id, id)).get();
  // If today became a scheduled day (or the task was re-activated), create today's instance right away
  if (patch.weekdays !== undefined || patch.active === 1) await materializeRecurring(db, localDate(c.env.TIMEZONE), true);
  return c.json({ ok: true, recurring: toRecurring(updated!) });
});

recurringRoutes.delete("/:id", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const teamPublic = c.get("teamPublic");
  const id = int(c.req.param("id"));
  const body = await readJson(c.req.raw);
  const reason = str(body.reason, 1000);
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  if (!reason || reason.length < 2) return c.json({ error: "חובה לכתוב סיבה למחיקה" }, 400);
  const row = await db.select().from(recurringTasks).where(and(eq(recurringTasks.id, id), isNull(recurringTasks.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  const mePublic = toPublicUser(me, false);
  if (!canManage(mePublic, row.assigneeId, teamPublic)) return c.json({ error: "אין הרשאה" }, 403);
  if (!canEditOrDelete(mePublic, row, teamPublic)) return c.json({ error: "רק מי שהוסיף את המשימה (או המנהל) יכול למחוק אותה" }, 403);
  await db
    .update(recurringTasks)
    .set({ active: 0, deletedAt: nowIso(), deletedById: me.id, deleteReason: reason })
    .where(eq(recurringTasks.id, id))
    .run();
  return c.json({ ok: true });
});
