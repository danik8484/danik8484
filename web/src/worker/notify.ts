import { and, asc, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import type { Env } from "./env";
import type { Db } from "./db/client";
import { notificationQueue, pushSubscriptions, tasks, users } from "./db/schema";
import { pushToUser, type PushContent } from "./push";
import { sendPlainEmail } from "./email";
import { localDate } from "./dates";

const DEBOUNCE_MS = 3 * 60 * 1000; // wait for a quiet period after the last added task
const MAX_WAIT_MS = 15 * 60 * 1000; // ...but never hold a digest longer than this

/** Deliver a message to a user: push to their devices, email as a fallback when configured. */
export async function notifyUser(env: Env, db: Db, userId: number, content: PushContent): Promise<"push" | "email" | "none"> {
  const delivered = await pushToUser(env, db, userId, content);
  if (delivered > 0) return "push";
  const user = await db.select().from(users).where(eq(users.id, userId)).get();
  if (user?.email && env.BREVO_API_KEY && env.MAIL_FROM) {
    try {
      await sendPlainEmail(env, user.email, content.title, content.body + (content.url ? `\n\n${content.url}` : ""));
      return "email";
    } catch (e) {
      console.error("email fallback failed", e);
    }
  }
  return "none";
}

/** Remember that `actorId` added a task for `userId`; digests are sent by the cron. */
export async function queueTaskNotification(db: Db, userId: number, actorId: number, taskId: number): Promise<void> {
  if (userId === actorId) return;
  await db.insert(notificationQueue).values({ userId, actorId, taskId, createdAt: Date.now() }).run();
}

function shortName(name: string, all: { id: number; name: string }[], id: number): string {
  const [first, ...rest] = name.trim().split(/\s+/);
  const clash = all.some((u) => u.id !== id && u.name.trim().split(/\s+/)[0] === first);
  return clash && rest.length > 0 ? `${first} ${rest[0][0]}.` : first;
}

/** Send one combined notification per user for tasks added since the last digest. */
export async function flushDigests(env: Env, db: Db, appUrl: string, now = Date.now(), force = false): Promise<number> {
  const pending = await db.select().from(notificationQueue).where(isNull(notificationQueue.sentAt)).orderBy(asc(notificationQueue.id)).all();
  if (pending.length === 0) return 0;
  const team = await db.select({ id: users.id, name: users.name }).from(users).all();
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
    const rows = await db
      .select({ id: tasks.id, title: tasks.title })
      .from(tasks)
      .where(and(inArray(tasks.id, taskIds), isNull(tasks.deletedAt)))
      .all();
    const titles = new Map(rows.map((r) => [r.id, r.title]));
    const live = items.filter((i) => titles.has(i.taskId));
    if (live.length > 0) {
      const actors = [...new Set(live.map((i) => i.actorId))].map((id) => shortName(team.find((u) => u.id === id)?.name ?? "", team, id));
      const who = actors.length === 1 ? actors[0] : actors.slice(0, -1).join(", ") + " ו" + actors[actors.length - 1];
      const n = live.length;
      const list = live.slice(0, 5).map((i) => `• ${titles.get(i.taskId)}`);
      if (n > 5) list.push(`ועוד ${n - 5}...`);
      const content: PushContent = {
        title: n === 1 ? `${who} הוסיף לך משימה` : `${who} הוסיף לך ${n} משימות`,
        body: list.join("\n"),
        url: appUrl + "/",
        tag: "new-tasks",
      };
      await notifyUser(env, db, userId, content);
      sent++;
    }
    await db
      .update(notificationQueue)
      .set({ sentAt: now })
      .where(inArray(notificationQueue.id, items.map((i) => i.id)))
      .run();
  }
  return sent;
}

/** Once a day after REMINDER_TIME: nudge everyone who still has open tasks for today. */
export async function sendDayEndReminders(env: Env, db: Db, appUrl: string, now = new Date()): Promise<number> {
  const tz = env.TIMEZONE;
  const today = localDate(tz, now);
  const [hh, mm] = (env.REMINDER_TIME || "20:00").split(":").map(Number);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  if (h * 60 + m < hh * 60 + mm) return 0;

  const candidates = await db
    .select()
    .from(users)
    .where(and(eq(users.active, 1), or(isNull(users.reminderSentDate), ne(users.reminderSentDate, today))))
    .all();
  let sent = 0;
  for (const u of candidates) {
    const open = await db
      .select({ n: sql<number>`count(*)`, inProgress: sql<number>`sum(case when status = 'in_progress' then 1 else 0 end)` })
      .from(tasks)
      .where(and(isNull(tasks.deletedAt), eq(tasks.assigneeId, u.id), lte(tasks.dueDate, today), or(eq(tasks.status, "open"), eq(tasks.status, "in_progress"))))
      .get();
    const n = Number(open?.n ?? 0);
    await db.update(users).set({ reminderSentDate: today }).where(eq(users.id, u.id)).run();
    if (n === 0) continue;
    const subs = await db.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, u.id)).all();
    if (subs.length === 0 && !(u.email && env.BREVO_API_KEY)) continue;
    await notifyUser(env, db, u.id, {
      title: "לפני שמסיימים את היום",
      body: n === 1 ? "נשארה לך משימה אחת פתוחה להיום. עדכן אותה: הושלם, או בתהליך עם פירוט." : `נשארו לך ${n} משימות פתוחות להיום. עדכן אותן: הושלם, או בתהליך עם פירוט.`,
      url: appUrl + "/",
      tag: "day-end",
    });
    sent++;
  }
  return sent;
}
