import { and, eq, isNotNull, isNull, lt, lte, ne, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { appMeta, recurringTasks, tasks, taskEvents, users } from "./db/schema";
import { weekdayOf } from "./dates";

const META_KEY = "last_materialized_date";

/**
 * Create today's instances of every active recurring task (idempotent).
 * Runs at most once per day per process path thanks to the app_meta marker,
 * unless `force` is set (used after a recurring task is created).
 * An instance belongs to its own day only (7.9: "משימה קבועה לא נגררת"): yesterday's undone instance is not carried over –
 * it stays in the history, its reminder is switched off, and today's instance is created fresh.
 */
export async function materializeRecurring(db: Db, today: string, force = false): Promise<number> {
  if (!force) {
    const marker = await db.select().from(appMeta).where(eq(appMeta.key, META_KEY)).get();
    if (marker && marker.value === today) return 0;
  }

  const wd = weekdayOf(today);
  const rows = await db
    .select({ r: recurringTasks, assigneeActive: users.active })
    .from(recurringTasks)
    .innerJoin(users, eq(users.id, recurringTasks.assigneeId))
    .where(and(eq(recurringTasks.active, 1), isNull(recurringTasks.deletedAt), lte(recurringTasks.startDate, today)))
    .all();

  let created = 0;
  for (const { r, assigneeActive } of rows) {
    if (!assigneeActive) continue;
    const days = r.weekdays.split(",").filter(Boolean).map(Number);
    if (!days.includes(wd)) continue;
    const inserted = await db
      .insert(tasks)
      .values({
        title: r.title,
        details: r.details,
        assigneeId: r.assigneeId,
        createdById: r.createdById,
        dueDate: today,
        recurringId: r.id,
        kind: r.kind,
        createdDate: today,
      })
      .onConflictDoNothing()
      .returning({ id: tasks.id })
      .get();
    if (inserted) {
      created++;
      await db
        .insert(taskEvents)
        .values({ taskId: inserted.id, actorId: r.createdById, type: "created", toStatus: "open", note: "משימה קבועה" })
        .run();
    }
  }

  // Reminders on undone instances of earlier days would keep firing for a task nobody sees any more.
  await db
    .update(tasks)
    .set({ reminderAt: null, reminderLastSentAt: null })
    .where(and(isNotNull(tasks.recurringId), isNull(tasks.deletedAt), ne(tasks.status, "done"), lt(tasks.dueDate, today), isNotNull(tasks.reminderAt)))
    .run();

  await db
    .insert(appMeta)
    .values({ key: META_KEY, value: today })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: sql`excluded.value` } })
    .run();
  return created;
}
