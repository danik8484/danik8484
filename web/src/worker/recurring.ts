import { and, eq, isNull, lte } from "drizzle-orm";
import type { Db } from "./db/client";
import { recurringTasks, tasks, taskEvents, users } from "./db/schema";
import { weekdayOf } from "./dates";

/** Create today's instances of every active recurring task (idempotent). */
export async function materializeRecurring(db: Db, today: string): Promise<void> {
  const wd = weekdayOf(today);
  const rows = await db
    .select({ r: recurringTasks, assigneeActive: users.active })
    .from(recurringTasks)
    .innerJoin(users, eq(users.id, recurringTasks.assigneeId))
    .where(and(eq(recurringTasks.active, 1), isNull(recurringTasks.deletedAt), lte(recurringTasks.startDate, today)))
    .all();

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
        createdDate: today,
      })
      .onConflictDoNothing()
      .returning({ id: tasks.id })
      .get();
    if (inserted) {
      await db
        .insert(taskEvents)
        .values({ taskId: inserted.id, actorId: r.createdById, type: "created", toStatus: "open", note: "משימה קבועה" })
        .run();
    }
  }
}
