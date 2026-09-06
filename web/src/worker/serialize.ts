import { PAYMENT_METHODS, type PublicUser, type Task, type TaskEvent, type RecurringTask, type TaskStatus, type EventType, type Attachment, type Deal, type PaymentMethod } from "@shared/types";
import type { UserRow, TaskRow, TaskEventRow, RecurringRow, AttachmentRow } from "./db/schema";

export function parseDeals(json: string | null): Deal[] {
  if (!json) return [];
  try {
    const arr = JSON.parse(json);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((d) => d && typeof d.name === "string")
      .map((d) => {
        const deal: Deal = {
          name: String(d.name),
          amount: typeof d.amount === "number" && Number.isFinite(d.amount) ? d.amount : 0,
          method: (PAYMENT_METHODS as readonly string[]).includes(d.method) ? (d.method as PaymentMethod) : "",
        };
        if (typeof d.key === "string" && /^[a-f0-9]{8,32}$/.test(d.key)) deal.key = d.key;
        if (d.plusTraining === true) deal.plusTraining = true;
        if (typeof d.months === "number" && Number.isInteger(d.months) && d.months > 0) deal.months = d.months;
        if (typeof d.firstDue === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.firstDue)) deal.firstDue = d.firstDue;
        if (typeof d.upfront === "number" && Number.isFinite(d.upfront) && d.upfront > 0) deal.upfront = d.upfront;
        const dnd = d.dnd;
        if (dnd && typeof dnd === "object" && ["pending", "sent", "error"].includes(dnd.status)) {
          deal.dnd = {
            status: dnd.status,
            ...(typeof dnd.id === "string" ? { id: dnd.id } : {}),
            ...(typeof dnd.sentAt === "string" ? { sentAt: dnd.sentAt } : {}),
            ...(typeof dnd.attempts === "number" ? { attempts: dnd.attempts } : {}),
            ...(typeof dnd.error === "string" ? { error: dnd.error } : {}),
            ...(dnd.stale === true ? { stale: true } : {}),
          };
        }
        return deal;
      });
  } catch {
    return [];
  }
}

export function toPublicUser(u: UserRow, includeEmail: boolean): PublicUser {
  return {
    id: u.id,
    name: u.name,
    email: includeEmail ? u.email : null,
    phone: includeEmail ? u.phone : null,
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
    kind: t.kind,
    priority: t.priority,
    reminderAt: t.reminderAt,
    reminderLastSentAt: t.reminderLastSentAt,
    reminderEveryMin: t.reminderEveryMin ?? null,
    metricDeals: t.metricDeals,
    metricCalls: t.metricCalls,
    deals: parseDeals(t.dealsJson),
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
    kind: r.kind,
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
