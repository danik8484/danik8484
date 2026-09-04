import { Hono } from "hono";
import { and, desc, eq, gt, gte, inArray, isNull, lt, lte, notInArray, or, asc, sql } from "drizzle-orm";
import type { AppEnv } from "../context";
import { tasks, taskEvents, recurringTasks } from "../db/schema";
import { toTask, toEvent, toPublicUser, toAttachment } from "../serialize";
import { listAttachments, photoCounts } from "./photos";
import { adminFeedFor, adminFeedText, notifyTaskNow, queueTaskNotification } from "../notify";
import { fmtWeekdaysHe } from "../dates";
import { endOfLocalDay, isIsoDate, localDate, nowIso, startOfLocalDay, weekdayOf } from "../dates";
import { materializeRecurring } from "../recurring";
import { visibleIdsFor } from "../team";
import { canAssignTask, canChangeStatus, canEditOrDelete, canManage, canOpenTask, noteRequiredForInProgress } from "@shared/permissions";
import { int, readJson, str, weekdays as parseWeekdays } from "../validate";
import { PAYMENT_METHODS, PAYMENT_METHOD_LABEL, type BoardResponse, type DealsResponse, type PaymentMethod, type TaskPriority, type TaskStatus } from "@shared/types";
import { parseDeals } from "../serialize";

const PRIORITIES: TaskPriority[] = ["urgent", "high", "normal"];
const PRIORITY_NOTE: Record<TaskPriority, string> = { urgent: "חשיבות: 🚨 דחוף", high: "חשיבות: ⬆️ עדיפות גבוהה", normal: "" };
function parsePriority(v: unknown): TaskPriority | null {
  if (v === undefined || v === null || v === "") return "normal";
  return PRIORITIES.includes(v as TaskPriority) ? (v as TaskPriority) : null;
}

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
  const priority = parsePriority(body.priority);
  if (priority === null) return c.json({ error: "חשיבות לא תקינה" }, 400);
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
    const assignee = teamPublic.find((u) => u.id === assigneeId)?.name ?? "";
    c.executionCtx.waitUntil(adminFeedText(c.env, db, me, "🔁 משימה קבועה חדשה", [`${title} · של ${assignee} · ${fmtWeekdaysHe(wds.join(","))}${kind === "leads" ? " · לידים" : ""}`, details].filter(Boolean)));
    return c.json({ ok: true, recurringId: rec.id }, 201);
  }

  const row = await db
    .insert(tasks)
    .values({ title, details, assigneeId, createdById: me.id, dueDate, createdDate: today, kind, priority })
    .returning()
    .get();
  await db.insert(taskEvents).values({ taskId: row.id, actorId: me.id, type: "created", toStatus: "open", note: priority !== "normal" ? PRIORITY_NOTE[priority] : "" }).run();
  // Managers may send the full task right now instead of waiting for the batched digest.
  const notifyNow = body.notifyNow === true && me.role !== "employee" && assigneeId !== me.id;
  if (notifyNow) {
    // Send right away; if the person has no device and no WhatsApp, fall back to the batched digest so nothing is lost.
    c.executionCtx.waitUntil(
      notifyTaskNow(c.env, db, row, new URL(c.req.url).origin)
        .then((result) => (result === "none" ? queueTaskNotification(db, assigneeId, me.id, row.id) : undefined))
        .catch((e) => {
          console.error("immediate notice failed", e);
          return queueTaskNotification(db, assigneeId, me.id, row.id);
        }),
    );
  } else await queueTaskNotification(db, assigneeId, me.id, row.id);
  c.executionCtx.waitUntil(adminFeedFor(c.env, db, row.id, me, "created", { extra: notifyNow ? "נשלחה הודעה מיידית" : undefined }));
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
      const deals: { name: string; amount: number; method: PaymentMethod }[] = [];
      for (const d of body.deals as unknown[]) {
        const o = (d ?? {}) as Record<string, unknown>;
        const name = str(o.name, 100);
        if (!name || name.split(/\s+/).length < 2) return c.json({ error: "חובה למלא שם מלא (שם פרטי ומשפחה) לכל נסלק" }, 400);
        const n = typeof o.amount === "number" ? o.amount : o.amount === "" || o.amount === null || o.amount === undefined ? NaN : Number(o.amount);
        if (!Number.isFinite(n) || n <= 0 || n > 10_000_000) return c.json({ error: `חובה למלא סכום לנסלק ${name}` }, 400);
        const method = o.method as PaymentMethod;
        if (!(PAYMENT_METHODS as readonly string[]).includes(method)) return c.json({ error: `חובה לבחור אמצעי תשלום לנסלק ${name}` }, 400);
        deals.push({ name, amount: Math.round(n * 100) / 100, method });
      }
      const json = deals.length ? JSON.stringify(deals) : null;
      if (json !== row.dealsJson) {
        patch.dealsJson = json;
        patch.metricDeals = deals.length ? deals.length : null;
        metricNotes.push(
          deals.length ? `נסלקים: ${deals.length} (${deals.map((d) => `${d.name} ${d.amount}₪ ${PAYMENT_METHOD_LABEL[d.method]}`).join(", ")})` : "נסלקים: –",
        );
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
    patch.reminderAt = null; // a reminder stops the moment the task is done
    patch.reminderLastSentAt = null;
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
  c.executionCtx.waitUntil(
    adminFeedFor(c.env, db, id, me, changed ? "status" : "note", { note: [note ?? "", metricNotes.join(" · ")].filter(Boolean).join(" · "), fromStatus: row.status, toStatus: status }),
  );
  return c.json({ ok: true, task: toTask(updated!) });
});

/** Set or clear a reminder: the assignee gets a message at that time and every 30 minutes until done. */
taskRoutes.post("/:id/reminder", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const id = int(c.req.param("id"));
  const body = await readJson(c.req.raw);
  if (id === null) return c.json({ error: "לא נמצא" }, 404);
  const row = await db.select().from(tasks).where(and(eq(tasks.id, id), isNull(tasks.deletedAt))).get();
  if (!row) return c.json({ error: "לא נמצא" }, 404);
  if (!canManage(toPublicUser(me, false), row.assigneeId, c.get("teamPublic"))) return c.json({ error: "אין הרשאה" }, 403);
  if (row.status === "done") return c.json({ error: "המשימה כבר הושלמה" }, 400);
  let reminderAt: string | null = null;
  if (body.reminderAt !== null && body.reminderAt !== undefined && body.reminderAt !== "") {
    const d = new Date(String(body.reminderAt));
    if (Number.isNaN(d.getTime())) return c.json({ error: "תאריך ושעה לא תקינים" }, 400);
    if (d.getTime() < Date.now() - 5 * 60 * 1000) return c.json({ error: "התזכורת חייבת להיות בעתיד" }, 400);
    if (d.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) return c.json({ error: "תזכורת אפשר לקבוע עד שנה קדימה" }, 400);
    reminderAt = d.toISOString();
  }
  await db.update(tasks).set({ reminderAt, reminderLastSentAt: null, reminderById: reminderAt ? me.id : null, updatedAt: nowIso() }).where(eq(tasks.id, id)).run();
  const when = reminderAt ? new Intl.DateTimeFormat("he-IL", { timeZone: c.env.TIMEZONE, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(reminderAt)) : "";
  await db.insert(taskEvents).values({ taskId: id, actorId: me.id, type: "reminder", note: reminderAt ? `תזכורת ל-${when}` : "התזכורת בוטלה" }).run();
  c.executionCtx.waitUntil(adminFeedFor(c.env, db, id, me, "reminder", { extra: reminderAt ? `תזכורת ל-${when} (כל חצי שעה עד שמסמנים הושלם)` : "התזכורת בוטלה" }));
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
  if (body.priority !== undefined) {
    const priority = parsePriority(body.priority);
    if (priority === null) return c.json({ error: "חשיבות לא תקינה" }, 400);
    if (row.recurringId && priority !== "normal") return c.json({ error: "למשימה קבועה (יומית) אין חשיבות מיוחדת" }, 400);
    if (priority !== row.priority) {
      patch.priority = priority;
      changes.push(`חשיבות: ${PRIORITY_NOTE[priority] || "רגיל"}`.replace("חשיבות: חשיבות: ", "חשיבות: "));
    }
  }
  let reassignedTo: number | null = null;
  let reassignNote = "";
  if (body.assigneeId !== undefined) {
    const assigneeId = int(body.assigneeId);
    if (assigneeId === null) return c.json({ error: "איש צוות לא תקין" }, 400);
    if (assigneeId !== row.assigneeId) {
      // Only a *new* assignee must be active; editing a task whose assignee was deactivated stays possible.
      if (!canAssignTask(assigneeId, teamPublic)) return c.json({ error: "איש צוות לא תקין" }, 400);
      if (row.recurringId) return c.json({ error: "משימה קבועה אי אפשר להעביר לאיש צוות אחר" }, 400);
      patch.assigneeId = assigneeId;
      reassignedTo = assigneeId;
      // A reminder follows the task only when the editor manages the new assignee's card.
      if (row.reminderAt && !canManage(mePublic, assigneeId, teamPublic)) {
        patch.reminderAt = null;
        patch.reminderLastSentAt = null;
        patch.reminderById = null;
      }
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
    reassignNote = `הועברה מ${from} אל ${to}`;
    await db.insert(taskEvents).values({ taskId: id, actorId: me.id, type: "reassigned", note: `${from} ← ${to}` }).run();
    await queueTaskNotification(db, reassignedTo, me.id, id);
  }
  const updated = await db.select().from(tasks).where(eq(tasks.id, id)).get();
  c.executionCtx.waitUntil(adminFeedFor(c.env, db, id, me, reassignedTo !== null ? "reassigned" : "edited", { extra: [reassignNote, ...changes].filter(Boolean).join(" · ") || undefined }));
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
  c.executionCtx.waitUntil(adminFeedFor(c.env, db, id, me, "deleted", { extra: `סיבה: ${reason}` }));
  return c.json({ ok: true });
});

/** Closed deals ("נסלקים") across the people I can see, for the separate deals page. */
export const dealRoutes = new Hono<AppEnv>();
dealRoutes.get("/", async (c) => {
  const db = c.get("db");
  const me = c.get("user");
  const visible = visibleIdsFor(me, c.get("team"));
  const today = localDate(c.env.TIMEZONE);
  const from = isIsoDate(c.req.query("from")) ? (c.req.query("from") as string) : today.slice(0, 8) + "01";
  const to = isIsoDate(c.req.query("to")) ? (c.req.query("to") as string) : today;
  const who = int(c.req.query("userId") ?? "");
  const ids = who !== null ? visible.filter((id) => id === who) : visible;
  const rows = ids.length
    ? await db
        .select({ id: tasks.id, dueDate: tasks.dueDate, assigneeId: tasks.assigneeId, dealsJson: tasks.dealsJson })
        .from(tasks)
        .where(and(isNull(tasks.deletedAt), inArray(tasks.assigneeId, ids), eq(tasks.kind, "leads"), gte(tasks.dueDate, from), lte(tasks.dueDate, to)))
        .orderBy(desc(tasks.dueDate), desc(tasks.id))
        .all()
    : [];
  const deals: DealsResponse["deals"] = [];
  const byMethod: DealsResponse["byMethod"] = {};
  let total = 0;
  for (const r of rows) {
    for (const d of parseDeals(r.dealsJson)) {
      deals.push({ ...d, taskId: r.id, date: r.dueDate, assigneeId: r.assigneeId });
      total += d.amount;
      const k = d.method || "unknown";
      byMethod[k] = { count: (byMethod[k]?.count ?? 0) + 1, amount: (byMethod[k]?.amount ?? 0) + d.amount };
    }
  }
  return c.json<DealsResponse>({ from, to, deals, total: Math.round(total * 100) / 100, byMethod });
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
