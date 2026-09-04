import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Env } from "./env";
import type { Db } from "./db/client";
import { notificationQueue, pushSubscriptions, tasks, users, type TaskRow, type UserRow } from "./db/schema";
import { pushToUser, type PushContent } from "./push";
import { sendWhatsApp, whatsappConfigured } from "./whatsapp";
import { sendTelegram, telegramConfigured, escapeHtml } from "./telegram";
import { getSettings } from "./settings";
import { chunk } from "./validate";
import { localDate, weekdayOf } from "./dates";
import { parseDeals } from "./serialize";
import { PAYMENT_METHOD_LABEL, type AppSettings, type TaskPriority } from "@shared/types";

const DEBOUNCE_MS = 3 * 60 * 1000; // wait for a quiet period after the last added task
const MAX_WAIT_MS = 15 * 60 * 1000; // ...but never hold a digest longer than this
const TASK_REMINDER_EVERY_MS = 30 * 60 * 1000;

export const PRIORITY_LABEL: Record<TaskPriority, string> = { urgent: "🚨 דחוף", high: "⬆️ עדיפות גבוהה", normal: "רגיל" };

function priorityPrefix(p: TaskPriority): string {
  return p === "urgent" ? "🚨 דחוף: " : p === "high" ? "⬆️ " : "";
}

/** Deliver a message to a user: push to their devices, and WhatsApp to their private phone when configured. */
export async function notifyUser(env: Env, db: Db, userId: number, content: PushContent, settings?: AppSettings): Promise<"push" | "whatsapp" | "both" | "none"> {
  const s = settings ?? (await getSettings(db, env));
  const delivered = await pushToUser(env, db, userId, content);
  let sent = false;
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user?.phone && whatsappConfigured(s)) {
    try {
      await sendWhatsApp(s, user.phone, `${content.title}: ${content.body}${content.url ? ` ${content.url}` : ""}`);
      sent = true;
    } catch (e) {
      console.error("whatsapp notification failed", e);
    }
  }
  if (delivered > 0 && sent) return "both";
  if (delivered > 0) return "push";
  return sent ? "whatsapp" : "none";
}

/** Remember that `actorId` added a task for `userId`; digests are sent by the cron. */
export async function queueTaskNotification(db: Db, userId: number, actorId: number, taskId: number): Promise<void> {
  if (userId === actorId) return;
  await db.insert(notificationQueue).values({ userId, actorId, taskId, createdAt: Date.now() }).run();
}

export function shortName(name: string, all: { id: number; name: string }[], id: number): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  const clash = all.some((u) => u.id !== id && u.name.trim().split(/\s+/)[0] === first);
  return clash && rest.length > 0 ? `${first} ${rest[0][0]}.` : first;
}

/** Full-detail text of a task, used for immediate notices and reminders. */
export function describeTask(t: TaskRow, team: { id: number; name: string }[]): string {
  const by = team.find((u) => u.id === t.createdById)?.name ?? "";
  const parts = [`${priorityPrefix(t.priority)}${t.title}`];
  if (t.details) parts.push(t.details);
  parts.push(`ליום ${t.dueDate.slice(8, 10)}.${t.dueDate.slice(5, 7)}`);
  if (by) parts.push(`מאת ${by}`);
  return parts.join(" · ");
}

/** Managers can bypass the digest: one message right now with the full task. */
export async function notifyTaskNow(env: Env, db: Db, task: TaskRow, appUrl: string): Promise<void> {
  const team = await db.select({ id: users.id, name: users.name }).from(users).all();
  await notifyUser(env, db, task.assigneeId, {
    title: task.priority === "urgent" ? "🚨 משימה דחופה חדשה" : "משימה חדשה",
    body: describeTask(task, team),
    url: appUrl + "/",
    tag: `task-${task.id}`,
  });
}

/** Send one combined notification per user for tasks added since the last digest. */
export async function flushDigests(env: Env, db: Db, appUrl: string, now = Date.now(), force = false): Promise<number> {
  const pending = await db.select().from(notificationQueue).where(isNull(notificationQueue.sentAt)).orderBy(asc(notificationQueue.id)).all();
  if (pending.length === 0) return 0;
  const settings = await getSettings(db, env);
  const team = await db.select({ id: users.id, name: users.name, active: users.active }).from(users).all();
  const byUser = new Map<number, typeof pending>();
  for (const p of pending) {
    if (!byUser.has(p.userId)) byUser.set(p.userId, []);
    byUser.get(p.userId)!.push(p);
  }
  let sent = 0;
  for (const [userId, items] of byUser) {
    const newest = Math.max(...items.map((i) => i.createdAt));
    const oldest = Math.min(...items.map((i) => i.createdAt));
    if (!force && now - newest < DEBOUNCE_MS && now - oldest < MAX_WAIT_MS) continue;

    const taskIds = [...new Set(items.map((i) => i.taskId))];
    const rows: { id: number; title: string; priority: TaskPriority }[] = [];
    for (const ids of chunk(taskIds)) {
      rows.push(...(await db.select({ id: tasks.id, title: tasks.title, priority: tasks.priority }).from(tasks).where(and(inArray(tasks.id, ids), isNull(tasks.deletedAt))).all()));
    }
    const byId = new Map(rows.map((r) => [r.id, r]));
    const live = items.filter((i) => byId.has(i.taskId));
    const recipientActive = team.find((u) => u.id === userId)?.active === 1;
    if (live.length > 0 && recipientActive) {
      const actors = [...new Set(live.map((i) => i.actorId))].map((id) => shortName(team.find((u) => u.id === id)?.name ?? "", team, id));
      const who = actors.length === 1 ? actors[0] : actors.slice(0, -1).join(", ") + " ו" + actors[actors.length - 1];
      const n = live.length;
      const list = live.slice(0, 5).map((i) => {
        const t = byId.get(i.taskId)!;
        return `• ${priorityPrefix(t.priority)}${t.title}`;
      });
      if (n > 5) list.push(`ועוד ${n - 5}...`);
      await notifyUser(
        env,
        db,
        userId,
        { title: n === 1 ? `${who} הוסיף/ה לך משימה` : `${who} הוסיף/ה לך ${n} משימות`, body: list.join("\n"), url: appUrl + "/", tag: "new-tasks" },
        settings,
      );
      sent++;
    }
    for (const ids of chunk(items.map((i) => i.id))) {
      await db.update(notificationQueue).set({ sentAt: now }).where(inArray(notificationQueue.id, ids)).run();
    }
  }
  return sent;
}

function localHHMM(tz: string, now: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

/**
 * Daily reminders, once per day per person, at the weekday's configured time:
 * Sun–Thu 21:00 and Fri 14:00 → "update your schedule" (only to people with tasks not yet updated);
 * Sat 19:00 → "add the essential tasks for the coming week" (to everyone).
 */
export async function sendDayEndReminders(env: Env, db: Db, appUrl: string, now = new Date(), force = false): Promise<number> {
  const tz = env.TIMEZONE;
  const today = localDate(tz, now);
  const settings = await getSettings(db, env);
  const wd = weekdayOf(today);
  const at = settings.reminderTimes[wd] || "";
  if (!at) return 0;
  const [hh, mm] = at.split(":").map(Number);
  if (!force && localHHMM(tz, now) < hh * 60 + mm) return 0;

  const candidates = await db
    .select()
    .from(users)
    .where(and(eq(users.active, 1), or(isNull(users.reminderSentDate), ne(users.reminderSentDate, today))))
    .all();
  let sent = 0;
  for (const u of candidates) {
    await db.update(users).set({ reminderSentDate: today }).where(eq(users.id, u.id)).run();
    const reachable = (await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, u.id)).all()).length > 0 || (!!u.phone && whatsappConfigured(settings));
    if (!reachable) continue;

    if (wd === 6) {
      await notifyUser(
        env,
        db,
        u.id,
        { title: "מתכננים את השבוע", body: "מחר מתחיל שבוע חדש. הוסף ללו\"ז את המשימות ההכרחיות שלך לשבוע הקרוב.", url: appUrl + "/", tag: "plan-week" },
        settings,
      );
      sent++;
      continue;
    }

    const open = await db
      .select({ n: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          isNull(tasks.deletedAt),
          eq(tasks.assigneeId, u.id),
          lte(tasks.dueDate, today),
          or(eq(tasks.status, "open"), and(eq(tasks.status, "in_progress"), eq(tasks.progressNote, ""))),
        ),
      )
      .get();
    const n = Number(open?.n ?? 0);
    if (n === 0) continue;
    await notifyUser(
      env,
      db,
      u.id,
      {
        title: "לפני שמסיימים את היום",
        body: n === 1 ? "יש לך משימה אחת שעדיין לא עודכנה בלו\"ז. סמן הושלם, או בתהליך עם פירוט." : `יש לך ${n} משימות שעדיין לא עודכנו בלו"ז. סמן הושלם, או בתהליך עם פירוט.`,
        url: appUrl + "/",
        tag: "day-end",
      },
      settings,
    );
    sent++;
  }
  return sent;
}

/** Per-task reminders: first at the chosen time, then every 30 minutes until the task is done. */
export async function sendTaskReminders(env: Env, db: Db, appUrl: string, now = new Date()): Promise<number> {
  const nowIsoStr = now.toISOString();
  const resendBefore = new Date(now.getTime() - TASK_REMINDER_EVERY_MS).toISOString();
  const due = await db
    .select()
    .from(tasks)
    .where(
      and(
        isNull(tasks.deletedAt),
        ne(tasks.status, "done"),
        lte(tasks.reminderAt, nowIsoStr),
        or(isNull(tasks.reminderLastSentAt), lte(tasks.reminderLastSentAt, resendBefore)),
      ),
    )
    .all();
  if (due.length === 0) return 0;
  const settings = await getSettings(db, env);
  const team = await db.select({ id: users.id, name: users.name, active: users.active }).from(users).all();
  let sent = 0;
  for (const t of due) {
    await db.update(tasks).set({ reminderLastSentAt: nowIsoStr }).where(eq(tasks.id, t.id)).run();
    if (team.find((u) => u.id === t.assigneeId)?.active !== 1) continue;
    await notifyUser(
      env,
      db,
      t.assigneeId,
      { title: "⏰ תזכורת למשימה", body: `${describeTask(t, team)} · ההודעה תחזור כל חצי שעה עד שתסמן הושלם`, url: appUrl + "/", tag: `reminder-${t.id}` },
      settings,
    );
    sent++;
  }
  return sent;
}

/* ------------------------------------------------------------------ */
/* Admin feed: every change, with full details, to the admin's Telegram */
/* ------------------------------------------------------------------ */

export type AdminEventKind = "created" | "status" | "note" | "edited" | "reassigned" | "deleted" | "photo" | "photo_removed" | "reminder";

const KIND_LABEL: Record<AdminEventKind, string> = {
  created: "➕ משימה חדשה",
  status: "🔄 שינוי סטטוס",
  note: "📝 עדכון פירוט",
  edited: "✏️ משימה נערכה",
  reassigned: "↔️ משימה הועברה",
  deleted: "🗑️ משימה נמחקה",
  photo: "📷 תמונה נוספה",
  photo_removed: "📷 תמונה הוסרה",
  reminder: "⏰ תזכורת נקבעה",
};

const STATUS_HE: Record<string, string> = { open: "פתוח", in_progress: "בתהליך", done: "הושלם ✅" };

/** Compose and send the Telegram message. Never throws (errors are logged). */
export async function adminFeed(
  env: Env,
  db: Db,
  input: { kind: AdminEventKind; task: TaskRow; actor: UserRow; note?: string; fromStatus?: string; toStatus?: string; extra?: string },
): Promise<void> {
  try {
    const s = await getSettings(db, env);
    if (!telegramConfigured(s)) return;
    if (input.actor.role === "admin" && !s.telegramNotifyOwnActions) return;
    const team = await db.select().from(users).all();
    const name = (id: number | null) => team.find((u) => u.id === id)?.name ?? "";
    const t = input.task;
    const lines: string[] = [];
    lines.push(`<b>${KIND_LABEL[input.kind]}</b>`);
    lines.push(`<b>${escapeHtml(priorityPrefix(t.priority) + t.title)}</b>${t.recurringId ? " (קבועה)" : ""}${t.kind === "leads" ? " · לידים" : ""}`);
    if (t.details) lines.push(escapeHtml(t.details));
    lines.push(`👤 של: ${escapeHtml(name(t.assigneeId))} · מאת: ${escapeHtml(name(t.createdById))} · ליום ${t.dueDate.slice(8, 10)}.${t.dueDate.slice(5, 7)}`);
    if (input.kind === "status" && input.fromStatus && input.toStatus) lines.push(`סטטוס: ${STATUS_HE[input.fromStatus] ?? input.fromStatus} ← ${STATUS_HE[input.toStatus] ?? input.toStatus}`);
    else lines.push(`סטטוס: ${STATUS_HE[t.status] ?? t.status}`);
    if (t.progressNote && (t.status === "in_progress" || input.kind === "note")) lines.push(`מה בוצע ומה נשאר: ${escapeHtml(t.progressNote)}`);
    if (input.note && input.note !== t.progressNote) lines.push(escapeHtml(input.note));
    if (t.kind === "leads") {
      const deals = parseDeals(t.dealsJson);
      if (t.metricCalls != null) lines.push(`שיחות: ${t.metricCalls}`);
      if (deals.length) lines.push(`נסלקים: ${deals.length} — ${deals.map((d) => `${escapeHtml(d.name)} ${d.amount}₪ (${d.method ? PAYMENT_METHOD_LABEL[d.method] : "לא צוין"})`).join(", ")}`);
    }
    if (input.extra) lines.push(escapeHtml(input.extra));
    lines.push(`🙋 בוצע על ידי: <b>${escapeHtml(input.actor.name)}</b> · ${new Intl.DateTimeFormat("he-IL", { timeZone: env.TIMEZONE, day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date())}`);
    if (env.APP_URL) lines.push(`<a href="${env.APP_URL}/?task=${t.id}">פתיחה במערכת</a>`);
    await sendTelegram(s, lines.join("\n"));
  } catch (e) {
    console.error("admin feed failed", e);
  }
}

/** Convenience: load the task row and the actor, then feed. */
export async function adminFeedFor(env: Env, db: Db, taskId: number, actor: UserRow, kind: AdminEventKind, opts: { note?: string; fromStatus?: string; toStatus?: string; extra?: string } = {}) {
  const t = await db.select().from(tasks).where(eq(tasks.id, taskId)).get();
  if (!t) return;
  await adminFeed(env, db, { kind, task: t, actor, ...opts });
}

