import type { PublicUser, Task, TaskEvent, RecurringTask, TaskStatus, EventType, Attachment } from "@shared/types";
import type { UserRow, TaskRow, TaskEventRow, RecurringRow, AttachmentRow } from "./db/schema";

export function toPublicUser(u: UserRow, includeEmail: boolean): PublicUser {
  return {
    id: u.id,
    name: u.name,
    email: includeEmail ? u.email : null,
    role: u.role,
    managerId: u.managerId,
    sortOrder: u.sortOrder,
    active: u.active === 1,
  };
}

export function toTask(t: TaskRow): Task {
  return {
    id: t.id,
    title: t.title,
    details: t.details,
    assigneeId: t.assigneeId,
    createdById: t.createdById,
    dueDate: t.dueDate,
    status: t.status as TaskStatus,
    progressNote: t.progressNote,
    completedAt: t.completedAt,
    completedDate: t.completedDate,
    completedById: t.completedById,
    recurringId: t.recurringId,
    createdDate: t.createdDate,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    deletedAt: t.deletedAt,
    deletedById: t.deletedById,
    deleteReason: t.deleteReason,
  };
}

export function toEvent(e: TaskEventRow): TaskEvent {
  return {
    id: e.id,
    taskId: e.taskId,
    actorId: e.actorId,
    type: e.type as EventType,
    fromStatus: (e.fromStatus as TaskStatus | null) ?? null,
    toStatus: (e.toStatus as TaskStatus | null) ?? null,
    note: e.note,
    createdAt: e.createdAt,
  };
}

export function toRecurring(r: RecurringRow): RecurringTask {
  return {
    id: r.id,
    title: r.title,
    details: r.details,
    assigneeId: r.assigneeId,
    createdById: r.createdById,
    weekdays: r.weekdays
      .split(",")
      .filter(Boolean)
      .map((n) => Number(n)),
    startDate: r.startDate,
    active: r.active === 1,
    createdAt: r.createdAt,
  };
}

export function toAttachment(a: AttachmentRow): Attachment {
  return {
    id: a.id,
    taskId: a.taskId,
    uploadedById: a.uploadedById,
    fileName: a.fileName,
    contentType: a.contentType,
    size: a.size,
    width: a.width,
    height: a.height,
    createdAt: a.createdAt,
  };
}
