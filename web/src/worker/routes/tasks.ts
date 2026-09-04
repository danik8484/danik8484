import { Hono } from "hono";
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, or, asc, sql } from "drizzle-orm";
import type { AppEnv } from "../context";
import { tasks, taskEvents, recurringTasks } from "../db/schema";
import { toTask, toEvent, toPublicUser, toAttachment } from "../serialize";
import { listAttachments, photoCounts } from "./photos";
import { queueTaskNotification } from "../notify";
import { endOfLocalDay, isIsoDate, localDate, nowIso, startOfLocalDay, weekdayOf } from "../dates";
import { materializeRecurring } from "../recurring";
import { visibleIdsFor } from "../team";
import { canAssignTask, canChangeStatus, canEditOrDelete, canManage, canOpenTask, noteRequiredForInProgress } from "@shared/permissions";
import { int, readJson, str, weekdays as parseWeekdays } from "../validate";
import type { BoardResponse, TaskStatus } from "@shared/types";

export const taskRoutes = new Hono<AppEnv>();

const STATUSES: TaskStatus[] = ["open", "in_progress", "done"];

taskRoutes.get("/board", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const team = c.get("team");
  const today = localDate(c.env.TIMEZONE);
  const date = c.req.query("date") && isIsoDate(c.req.query("date")) ? (c.req.query("date") as string) : today;

  await materializeRecurring(db, today);

  const visible = visibleIdsFor(me, team);
  // A finished task stays on the board from its due date until the day it was completed, in either
  // order (completed early or late), so a manager always gets to see it as done at least once.
  const doneVisibleOn = (d: string) =>
    sql`(${tasks.status} = 'done' AND min(${tasks.dueDate}, coalesce(${tasks.completedDate}, ${tasks.dueDate})) <= ${d} AND max(${tasks.dueDate}, coalesce(${tasks.completedDate}, ${tasks.dueDate})) >= ${d})`;
  const notDone = or(eq(tasks.status, "open"), eq(tasks.status, "in_progress"));
  const sent = await db
    .select()
    .from(tasks)
    .where(and(isNull(tasks.deletedAt), eq(tasks.createdById, me.id), notInArray(tasks.assigneeId, visible.length ? visible : [-1]), or(notDone, doneVisibleOn(date))))
    .orderBy(asc(tasks.dueDate), asc(tasks.id))
    .all();
  if (visible.length === 0) return c.json<BoardResponse>({ date, today, tasks: [], upcoming: [], sent: sent.map(toTask) });

  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNull(tasks.deletedAt),
        inArray(tasks.assigneeId, visible),
        lte(tasks.createdDate, date),
        or(and(notDone, lte(tasks.dueDate, date)), doneVisibleOn(date)),
      ),
    )
    .orderBy(asc(tasks.dueDate), asc(tasks.id))
    .all();

  const upcoming = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNull(tasks.deletedAt),
        inArray(tasks.assigneeId, visible),
        gt(tasks.dueDate, date),
        lte(tasks.createdDate, date),
        notDone,
      ),
    )
    .orderBy(asc(tasks.dueDate), asc(tasks.id))
    .all();

  const counts = await photoCounts(db, [...rows, ...upcoming, ...sent].map((t) => t.id));
  const withCount = (t: typeof rows[number]) => ({ ...toTask(t), photoCount: counts.get(t.id) ?? 0 });
  return c.json<BoardResponse>({ date, today, tasks: rows.map(withCount), upcoming: upcoming.map(withCount), sent: sent.map(withCount) });
});

taskRoutes.post("/", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const body = await readJson(c.req.raw);
  const title = str(body.title, 200);
  const details = str(body.details, 3000, { required: false });
  const assigneeId = int(body.assigneeId);
  const dueDate = body.dueDate;
  const wds = parseWeekdays(body.weekdays);
  if (!title) return c.json({ error: "חובה להזין שם משימה" }, 400);
  if (details === null) return c.json({ error: "הפירוט ארוך מדי" }, 400);
  if (assigneeId === null) return c.json({ error: "חובה לבחור איש צוות" }, 400);
  if (!isIsoDate(dueDate)) return c.json({ error: "תאריך לא תקין" }, 400);
  if (wds === null) return c.json({ error: "ימים לא תקינים" }, 400);
  const teamPublic = c.get("teamPublic");
  if (!canAssignTask(assigneeId, teamPublic)) return c.json({ error: "איש צוות לא תקין" }, 400);
  if (wds.length > 0 && !canManage(toPublicUser(me, false), assigneeId, teamPublic)) {
    return c.json({ error: "משימה קבועה אפשר להגדיר רק לעצמך או לאנשי צוות שאתה מנהל" }, 403);
  }

  const today = localDate(c.env.TIMEZONE);

  const kind = body.kind === "leads" ? "leads" : "normal";
  if (wds.length > 0) {
    const rec = await db
      .insert(recurringTasks)
      .values({ title, details, assigneeId, createdById: me.id, weekdays: wds.join(","), startDate: dueDate, kind })
      .returning()
      .get();
    // Create the first instance now if the start date is today and matches a selected weekday
    if (dueDate <= today && wds.includes(weekdayOf(today))) {
      await materializeRecurring(db, today, true);
    }
    return c.json({ ok: true, recurringId: rec.id }, 201);
  }

  const row = await db
    .insert(tasks)
    .values({ title, details, assigneeId, createdById: me.id, dueDate, createdDate: today, kind })
    .returning()
    .get();
  await db.insert(taskEvents).values({ taskId: row.id, actorId: me.id, type: "created", toStatus: "open" }).run();
  await queueTaskNotification(db, assigneeId, me.id, row.id);
  return c.json({ ok: true, task: toTask(row) }, 201);
});

taskRoutes.get("/:id", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const id = int(c.req.param("id"));
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  if (!canOpenTask(toPublicUser(me, false), row, c.get("teamPublic"))) return c.json({ error: "אין הרשאה" }, 403);
  const events = await db.select().from(taskEvents).where(eq(taskEvents.taskId, id)).orderBy(asc(taskEvents.id)).all();
  const attachments = await listAttachments(db, id);
  return c.json({ task: toTask(row), events: events.map(toEvent), attachments: attachments.map(toAttachment) });
});

taskRoutes.post("/:id/status", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const id = int(c.req.param("id"));
  const body = await readJson(c.req.raw);
  const status = body.status as TaskStatus;
  const note = str(body.note, 2000, { required: false });
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  if (!STATUSES.includes(status)) return c.json({ error: "סטטוס לא תקין" }, 400);
  if (note === null) return c.json({ error: "הפירוט ארוך מדי" }, 400);
  const row = await db.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  const mePublic = toPublicUser(me, false);
  if (!canManage(mePublic, row.assigneeId, c.get("teamPublic"))) return c.json({ error: "אין הרשאה" }, 403);
  if (status !== row.status && !canChangeStatus(mePublic, row, status, c.get("teamPublic"))) {
    return c.json(
      { error: row.status === "done" ? "רק המנהל יכול לפתוח מחדש משימה שסומנה כהושלמה." : "רק המנהל יכול לסמן 'הושלם' על משימה שניתנה על ידי מישהו אחר. סמן 'בתהליך' וכתוב מה בוצע." },
      403,
    );
  }
  if (status === "in_progress" && !note && noteRequiredForInProgress(row)) {
    return c.json({ error: "כשמסמנים 'בתהליך' חובה לפרט מה בוצע ומה נשאר" }, 400);
  }

  const now = nowIso();
  const today = localDate(c.env.TIMEZONE);
  const changed = status !== row.status;
  const patch: Partial<typeof tasks.$inferInsert> = { updatedAt: now };
  const metricNotes: string[] = [];
  if (row.kind === "leads") {
    // Calls: a plain count
    if (body.metricCalls !== undefined) {
      const raw = body.metricCalls;
      const v = raw === null || raw === "" ? null : int(raw);
      if (v === undefined || v === null && raw !== null && raw !== "") return c.json({ error: "כמות שיחות לא תקינה" }, 400);
      if (v !== null && (v < 0 || v > 100000)) return c.json({ error: "כמות שיחות לא תקינה" }, 400);
      if (v !== row.metricCalls) {
        patch.metricCalls = v;
        metricNotes.push(`שיחות: ${v ?? "–"}`);
      }
    }
    // Closed deals: a list of {name, amount}; the count is derived.
    // TODO(DND CASH): push these deals into the DND CASH system once that integration is built.
    if (body.deals !== undefined) {
      if (!Array.isArray(body.deals) || body.deals.length > 50) return c.json({ error: "רשימת נסלקים לא תקינה" }, 400);
      const deals: { name: string; amount: number | null }[] = [];
      for (const d of body.deals as unknown[]) {
        const o = (d ?? {}) as Record<string, unknown>;
        const name = str(o.name, 100);
        if (!name) return c.json({ error: "חובה למלא שם לקוח לכל נסלק" }, 400);
        let amount: number | null = null;
        if (o.amount !== undefined && o.amount !== null && o.amount !== "") {
          const n = typeof o.amount === "number" ? o.amount : Number(o.amount);
          if (!Number.isFinite(n) || n < 0 || n > 10_000_000) return c.json({ error: "סכום לא תקין" }, 400);
          amount = Math.round(n * 100) / 100;
        }
        deals.push({ name, amount });
      }
      const json = deals.length ? JSON.stringify(deals) : null;
      if (json !== row.dealsJson) {
        patch.dealsJson = json;
        patch.metricDeals = deals.length ? deals.length : null;
        metricNotes.push(deals.length ? `נסלקים: ${deals.length} (${deals.map((d) => (d.amount != null ? `${d.name} ${d.amount}₪` : d.name)).join(", ")})` : "נסלקים: –");
      }
    }
  }
  if (status === "in_progress") patch.progressNote = note;
  else if (note) patch.progressNote = note;
  if (status === "done") {
    patch.status = "done";
    patch.completedAt = now;
    patch.completedDate = today;
    patch.completedById = me.id;
  } else {
    patch.status = status;
    patch.completedAt = null;
    patch.completedDate = null;
    patch.completedById = null;
  }
  if (!changed && !note && metricNotes.length === 0 && patch.progressNote === undefined) return c.json({ ok: true, task: toTask(row) });
  await db.update(tasks).set(patch).where(eq(tasks.id, id)).run();
  await db
    .insert(taskEvents)
    .values({
      taskId: id,
      actorId: me.id,
      type: changed ? "status" : "note",
      fromStatus: row.status,
      toStatus: status,
      note: [note ?? "", metricNotes.join(" · ")].filter(Boolean).join("\n"),
    })
    .run();
  const updated = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  return c.json({ ok: true, task: toTask(updated!) });
});

taskRoutes.patch("/:id", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const teamPublic = c.get("teamPublic");
  const id = int(c.req.param("id"));
  const body = await readJson(c.req.raw);
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = await db.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  const mePublic = toPublicUser(me, false);
  if (!canEditOrDelete(mePublic, row, teamPublic)) return c.json({ error: "רק מי שהוסיף את המשימה (או המנהל) יכול לערוך אותה" }, 403);

  const patch: Partial<typeof tasks.$inferInsert> = { updatedAt: nowIso() };
  const changes: string[] = [];
  if (body.title !== undefined) {
    const title = str(body.title, 200);
    if (!title) return c.json({ error: "חובה להזין שם משימה" }, 400);
    if (title !== row.title) {
      patch.title = title;
      changes.push(`שם: "${row.title}" ← "${title}"`);
    }
  }
  if (body.details !== undefined) {
    const details = str(body.details, 3000, { required: false });
    if (details === null) return c.json({ error: "הפירוט ארוך מדי" }, 400);
    if (details !== row.details) {
      patch.details = details;
      changes.push("פירוט עודכן");
    }
  }
  if (body.dueDate !== undefined) {
    if (!isIsoDate(body.dueDate)) return c.json({ error: "תאריך לא תקין" }, 400);
    if (body.dueDate !== row.dueDate) {
      if (row.recurringId) return c.json({ error: "התאריך של משימה קבועה נקבע אוטומטית ואי אפשר לשנות אותו. אפשר להוסיף משימה רגילה ליום אחר." }, 400);
      if (row.status === "done" && row.completedDate && body.dueDate > row.completedDate) {
        return c.json({ error: "אי אפשר לקבוע תאריך יעד מאוחר ממועד ההשלמה" }, 400);
      }
      patch.dueDate = body.dueDate;
      changes.push(`תאריך: ${row.dueDate} ← ${body.dueDate}`);
    }
  }
  let reassignedTo: number | null = null;
  if (body.assigneeId !== undefined) {
    const assigneeId = int(body.assigneeId);
    if (assigneeId === null) return c.json({ error: "איש צוות לא תקין" }, 400);
    if (assigneeId !== row.assigneeId) {
      // Only a *new* assignee must be active; editing a task whose assignee was deactivated stays possible.
      if (!canAssignTask(assigneeId, teamPublic)) return c.json({ error: "איש צוות לא תקין" }, 400);
      if (row.recurringId) return c.json({ error: "משימה קבועה אי אפשר להעביר לאיש צוות אחר" }, 400);
      patch.assigneeId = assigneeId;
      reassignedTo = assigneeId;
    }
  }
  if (changes.length === 0 && reassignedTo === null) return c.json({ ok: true, task: toTask(row) });

  await db.update(tasks).set(patch).where(eq(tasks.id, id)).run();
  if (changes.length > 0) {
    await db.insert(taskEvents).values({ taskId: id, actorId: me.id, type: "edited", note: changes.join(" · ") }).run();
  }
  if (reassignedTo !== null) {
    const from = c.get("team").find((u) => u.id === row.assigneeId)?.name ?? "";
    const to = c.get("team").find((u) => u.id === reassignedTo)?.name ?? "";
    await db.insert(taskEvents).values({ taskId: id, actorId: me.id, type: "reassigned", note: `${from} ← ${to}` }).run();
    await queueTaskNotification(db, reassignedTo, me.id, id);
  }
  const updated = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  return c.json({ ok: true, task: toTask(updated!) });
});

taskRoutes.delete("/:id", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const teamPublic = c.get("teamPublic");
  const id = int(c.req.param("id"));
  const body = await readJson(c.req.raw);
  const reason = str(body.reason, 1000);
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  if (!reason || reason.length < 2) return c.json({ error: "חובה לכתוב סיבה למחיקה" }, 400);
  const row = await db.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  const mePublic = toPublicUser(me, false);
  if (!canEditOrDelete(mePublic, row, teamPublic)) return c.json({ error: "רק מי שהוסיף את המשימה (או המנהל) יכול למחוק אותה" }, 403);
  const now = nowIso();
  await db.update(tasks).set({ deletedAt: now, deletedById: me.id, deleteReason: reason, updatedAt: now }).where(eq(tasks.id, id)).run();
  await db.insert(taskEvents).values({ taskId: id, actorId: me.id, type: "deleted", fromStatus: row.status, note: reason }).run();
  return c.json({ ok: true });
});

/** Activity log across visible users. */
export const logRoutes = new Hono<AppEnv>();
logRoutes.get("/", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  if (me.role === "employee") return c.json({ error: "אין הרשאה" }, 403);
  const visible = visibleIdsFor(me, c.get("team"));
  const from = isIsoDate(c.req.query("from")) ? (c.req.query("from") as string) : localDate(c.env.TIMEZONE, new Date(Date.now() - 7 * 86400000));
  const to = isIsoDate(c.req.query("to")) ? (c.req.query("to") as string) : localDate(c.env.TIMEZONE);
  const rows = await db
    .select({ e: taskEvents, title: tasks.title, assigneeId: tasks.assigneeId })
    .from(taskEvents)
    .innerJoin(tasks, eq(tasks.id, taskEvents.taskId))
    .where(
      and(
        inArray(tasks.assigneeId, visible),
        gte(taskEvents.createdAt, startOfLocalDay(c.env.TIMEZONE, from)),
        lt(taskEvents.createdAt, endOfLocalDay(c.env.TIMEZONE, to)),
      ),
    )
    .orderBy(desc(taskEvents.id))
    .limit(500)
    .all();
  return c.json({
    from,
    to,
    entries: rows.map((r) => ({ ...toEvent(r.e), taskTitle: r.title, taskAssigneeId: r.assigneeId })),
  });
});
