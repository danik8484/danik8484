import { Hono } from "hono";
import { and, asc, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import type { AppEnv } from "../context";
import { callItems, tasks, taskEvents } from "../db/schema";
import { toCallItem, toTask } from "../serialize";
import { int, readJson, str } from "../validate";
import { localDate, nowIso } from "../dates";
import { adminFeedFor, adminFeedText } from "../notify";

/** Shared call list: everyone sees it, anyone adds a person to call, whoever takes a row schedules the call (10.9). */
export const callRoutes = new Hono<AppEnv>();

const parsePhone = (v: unknown): string | null => {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string") return null;
  const digits = v.replace(/[^\d+]/g, "");
  return digits.length >= 7 && digits.length <= 16 ? digits : null;
};

callRoutes.get("/", async (c) => {
  const db = c.get("db");
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db
    .select()
    .from(callItems)
    .where(and(isNull(callItems.deletedAt), inArray(callItems.status, ["open", "scheduled"])))
    .orderBy(asc(callItems.status), asc(callItems.scheduledAt), asc(callItems.id))
    .all();
  const done = await db
    .select()
    .from(callItems)
    .where(and(isNull(callItems.deletedAt), eq(callItems.status, "done"), gte(callItems.doneAt, weekAgo)))
    .orderBy(desc(callItems.doneAt))
    .all();
  return c.json({ items: rows.map(toCallItem), done: done.map(toCallItem) });
});

callRoutes.post("/", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const body = await readJson(c.req.raw);
  const name = str(body.name, 100);
  if (!name) return c.json({ error: "חובה למלא שם" }, 400);
  const phone = parsePhone(body.phone);
  if (phone === null) return c.json({ error: "מספר טלפון לא תקין" }, 400);
  const note = str(body.note, 500, { required: false }) ?? "";
  const row = await db.insert(callItems).values({ name, phone, note, createdById: me.id }).returning().get();
  c.executionCtx.waitUntil(adminFeedText(c.env, db, me, "📞 נוסף לרשימת השיחות", [name, phone, note].filter(Boolean)));
  return c.json({ ok: true, item: toCallItem(row) }, 201);
});

/** Take a row: pick the call time → a task "שיחה עם X · HH:MM" with a reminder at that time, for me. */
callRoutes.post("/:id/take", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const id = int(c.req.param("id"));
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = await db.select().from(callItems).where(and(eq(callItems.id, id), isNull(callItems.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  if (row.status === "done") return c.json({ error: "השיחה כבר בוצעה" }, 400);
  if (row.status === "scheduled" && row.takenById !== me.id) return c.json({ error: "השיחה כבר נקבעה על ידי מישהו אחר" }, 409);
  const body = await readJson(c.req.raw);
  const at = new Date(String(body.at ?? ""));
  if (!body.at || Number.isNaN(at.getTime())) return c.json({ error: "חובה לבחור תאריך ושעה לשיחה" }, 400);
  if (at.getTime() < Date.now() - 5 * 60 * 1000) return c.json({ error: "השעה שנבחרה כבר עברה" }, 400);
  const tz = c.env.TIMEZONE;
  const dueDate = localDate(tz, at);
  const hhmm = new Intl.DateTimeFormat("he-IL", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
  const now = nowIso();
  const details = [row.phone ? `טלפון: ${row.phone}` : "", row.note, "מרשימת השיחות המשותפת"].filter(Boolean).join("\n");
  let taskId = row.taskId;
  const existing = taskId ? await db.select().from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt))).get() : undefined;
  if (existing && existing.status !== "done") {
    // re-scheduling my own call: move the task and its reminder
    await db
      .update(tasks)
      .set({ title: `שיחה עם ${row.name} · ${hhmm}`, dueDate, reminderAt: at.toISOString(), reminderLastSentAt: null, reminderById: me.id, reminderEveryMin: 60, updatedAt: now })
      .where(eq(tasks.id, existing.id))
      .run();
    await db.insert(taskEvents).values({ taskId: existing.id, actorId: me.id, type: "reminder", note: `השיחה נקבעה מחדש ל-${dueDate.slice(8, 10)}.${dueDate.slice(5, 7)} ${hhmm}` }).run();
  } else {
    const t = await db
      .insert(tasks)
      .values({
        title: `שיחה עם ${row.name} · ${hhmm}`,
        details,
        assigneeId: me.id,
        createdById: me.id,
        dueDate,
        createdDate: localDate(tz),
        kind: "normal",
        priority: "normal",
        reminderAt: at.toISOString(),
        reminderById: me.id,
        reminderEveryMin: 60,
      })
      .returning()
      .get();
    taskId = t.id;
    await db.insert(taskEvents).values({ taskId: t.id, actorId: me.id, type: "created", toStatus: "open", note: `מרשימת השיחות · תזכורת ב-${hhmm}` }).run();
    c.executionCtx.waitUntil(adminFeedFor(c.env, db, t.id, me, "created", { extra: "נלקח מרשימת השיחות" }));
  }
  await db.update(callItems).set({ status: "scheduled", takenById: me.id, scheduledAt: at.toISOString(), taskId, updatedAt: now }).where(eq(callItems.id, id)).run();
  const updated = await db.select().from(callItems).where(eq(callItems.id, id)).get();
  const task = await db.select().from(tasks).where(eq(tasks.id, taskId!)).get();
  return c.json({ ok: true, item: toCallItem(updated!), task: toTask(task!) });
});

/** Give a taken row back to the list; the task made for it goes away. Taker, admin, or whoever added the row. */
callRoutes.post("/:id/release", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const id = int(c.req.param("id"));
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = await db.select().from(callItems).where(and(eq(callItems.id, id), isNull(callItems.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  if (row.status !== "scheduled") return c.json({ error: "השיחה לא נקבעה" }, 400);
  if (row.takenById !== me.id && me.role !== "admin" && row.createdById !== me.id) return c.json({ error: "רק מי שקבע את השיחה (או המנהל הראשי) יכול לשחרר אותה" }, 403);
  const now = nowIso();
  if (row.taskId) {
    await db
      .update(tasks)
      .set({ deletedAt: now, deletedById: me.id, deleteReason: "השיחה שוחררה חזרה לרשימה המשותפת", updatedAt: now })
      .where(and(eq(tasks.id, row.taskId), isNull(tasks.deletedAt), ne(tasks.status, "done")))
      .run();
  }
  await db.update(callItems).set({ status: "open", takenById: null, scheduledAt: null, taskId: null, updatedAt: now }).where(eq(callItems.id, id)).run();
  const updated = await db.select().from(callItems).where(eq(callItems.id, id)).get();
  return c.json({ ok: true, item: toCallItem(updated!) });
});

/** The call happened: the row and its task are done. Taker or admin. */
callRoutes.post("/:id/done", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const id = int(c.req.param("id"));
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = await db.select().from(callItems).where(and(eq(callItems.id, id), isNull(callItems.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  if (row.status === "done") return c.json({ ok: true, item: toCallItem(row) });
  if (row.status !== "scheduled") return c.json({ error: "קודם קובעים את השיחה" }, 400);
  if (row.takenById !== me.id && me.role !== "admin") return c.json({ error: "רק מי שקבע את השיחה מסמן שבוצעה" }, 403);
  const now = nowIso();
  const today = localDate(c.env.TIMEZONE);
  if (row.taskId) {
    const t = await db.select().from(tasks).where(and(eq(tasks.id, row.taskId), isNull(tasks.deletedAt))).get();
    if (t && t.status !== "done") {
      await db.update(tasks).set({ status: "done", completedAt: now, completedDate: today, completedById: me.id, reminderAt: null, reminderLastSentAt: null, updatedAt: now }).where(eq(tasks.id, t.id)).run();
      await db.insert(taskEvents).values({ taskId: t.id, actorId: me.id, type: "status", fromStatus: t.status, toStatus: "done", note: "השיחה בוצעה ✓" }).run();
      c.executionCtx.waitUntil(adminFeedFor(c.env, db, t.id, me, "status", { fromStatus: t.status, toStatus: "done", note: "השיחה בוצעה ✓" }));
    }
  }
  await db.update(callItems).set({ status: "done", doneAt: now, updatedAt: now }).where(eq(callItems.id, id)).run();
  const updated = await db.select().from(callItems).where(eq(callItems.id, id)).get();
  return c.json({ ok: true, item: toCallItem(updated!) });
});

/** Remove a row from the list: whoever added it, or the admin. A scheduled row is released first. */
callRoutes.delete("/:id", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const id = int(c.req.param("id"));
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = await db.select().from(callItems).where(and(eq(callItems.id, id), isNull(callItems.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  if (row.createdById !== me.id && me.role !== "admin") return c.json({ error: "רק מי שהוסיף את השורה (או המנהל הראשי) יכול למחוק אותה" }, 403);
  if (row.status === "scheduled" && row.takenById !== me.id && me.role !== "admin") return c.json({ error: "השיחה נקבעה על ידי מישהו אחר – קודם לבקש ממנו לשחרר" }, 400);
  const now = nowIso();
  if (row.status === "scheduled" && row.taskId) {
    await db
      .update(tasks)
      .set({ deletedAt: now, deletedById: me.id, deleteReason: "השורה נמחקה מרשימת השיחות", updatedAt: now })
      .where(and(eq(tasks.id, row.taskId), isNull(tasks.deletedAt), ne(tasks.status, "done")))
      .run();
  }
  await db.update(callItems).set({ deletedAt: now, updatedAt: now }).where(eq(callItems.id, id)).run();
  return c.json({ ok: true });
});
