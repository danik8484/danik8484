import { and, eq, isNull, lte, sql } from "drizzle-orm";
import type { Db } from "./db/client";
import { appMeta, recurringTasks, tasks, taskEvents, users } from "./db/schema";
import { weekdayOf } from "./dates";

const META_KEY = "last_materialized_date";

/**
 * Create today's instances of every active recurring task (idempotent).
 * Runs at most once per day per process path thanks to the app_meta marker,
 * unless `force` is set (used after a recurring task is created).
 */
export async function materializeRecurring(db: Db, today: string, force = false): Promise<number> {
  if (!force) {
    const marker = await db.select().from(appMeta).where(eq(appMeta.key, META_KEY)).get();
    if (marker && marker.value === today) return 0;
  }

  const wd = weekdayOf(today);
  const rows = await db
    .select({ r: recurringTasks, assigneeActive: users.active, assigneeRole: users.role })
    .from(recurringTasks)
    .innerJoin(users, eq(users.id, recurringTasks.assigneeId))
    .where(and(eq(recurringTasks.active, 1), isNull(recurringTasks.deletedAt), lte(recurringTasks.startDate, today)))
    .all();

  let created = 0;
  for (const { r, assigneeActive, assigneeRole } of rows) {
    if (!assigneeActive || assigneeRole === "coordinator") continue;
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

  await db
    .insert(appMeta)
    .values({ key: META_KEY, value: today })
    .onConflictDoUpdate({ target: appMeta.key, set: { value: sql`excluded.value` } })
    .run();
  return created;
}
