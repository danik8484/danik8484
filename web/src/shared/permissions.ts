import type { PublicUser, Task } from "./types";

/** Which users' cards the viewer may see and act on. */
export function visibleUserIds(viewer: PublicUser, all: PublicUser[]): number[] {
  if (viewer.role === "admin") return all.map((u) => u.id);
  return all.filter((u) => u.id === viewer.id || u.managerId === viewer.id).map((u) => u.id);
}

export function canView(viewer: PublicUser, targetId: number, all: PublicUser[]): boolean {
  return visibleUserIds(viewer, all).includes(targetId);
}

/** Add tasks / change status / update notes for the target's card. Same as viewing. */
export function canManage(viewer: PublicUser, targetId: number, all: PublicUser[]): boolean {
  return canView(viewer, targetId, all);
}

/**
 * Edit title/details/date or delete a task:
 * - admin: always
 * - the person who created it
 * - a manager of the assignee, when the task was self-created by the assignee
 */
export function canEditOrDelete(viewer: PublicUser, task: Pick<Task, "assigneeId" | "createdById">, all: PublicUser[]): boolean {
  if (viewer.role === "admin") return true;
  if (task.createdById === viewer.id) return true;
  if (task.createdById === task.assigneeId && task.assigneeId !== viewer.id && canManage(viewer, task.assigneeId, all)) return true;
  return false;
}

export function canSeeActivityLog(viewer: PublicUser): boolean {
  return viewer.role === "admin" || viewer.role === "manager";
}

/** Anyone may add a one-off task to any active teammate, even without seeing their schedule. */
export function canAssignTask(targetId: number, all: PublicUser[]): boolean {
  const t = all.find((u) => u.id === targetId);
  return !!t && t.active;
}

/**
 * Where a task sits inside the assignee's card:
 * 0 = from management (admin or the assignee's direct manager) – top
 * 1 = the assignee's own task – middle
 * 2 = a request from another teammate – separate section at the bottom
 */
export function taskTier(task: Pick<Task, "assigneeId" | "createdById">, all: PublicUser[]): 0 | 1 | 2 {
  if (task.createdById === task.assigneeId) return 1;
  const creator = all.find((u) => u.id === task.createdById);
  const assignee = all.find((u) => u.id === task.assigneeId);
  if (creator?.role === "admin" || (assignee && assignee.managerId === task.createdById)) return 0;
  return 2;
}

/** The creator may always open a task they created, even for a teammate whose schedule is hidden. */
export function canOpenTask(viewer: PublicUser, task: Pick<Task, "assigneeId" | "createdById">, all: PublicUser[]): boolean {
  return canView(viewer, task.assigneeId, all) || task.createdById === viewer.id;
}

/**
 * Who may mark a task as done:
 * - recurring (daily) tasks: anyone who manages the assignee's card, including the assignee
 * - a task the assignee added for themselves: the assignee (and their managers)
 * - a task given by a manager or by another teammate: only the admin or the assignee's direct manager
 */
export function canMarkDone(viewer: PublicUser, task: Pick<Task, "assigneeId" | "createdById" | "recurringId">, all: PublicUser[]): boolean {
  if (!canManage(viewer, task.assigneeId, all)) return false;
  if (viewer.role === "admin") return true;
  if (task.recurringId) return true;
  if (task.createdById === task.assigneeId) return true;
  const assignee = all.find((u) => u.id === task.assigneeId);
  return !!assignee && assignee.managerId === viewer.id;
}

/** A progress note is required when marking "in progress", except for recurring (daily) tasks. */
export function noteRequiredForInProgress(task: Pick<Task, "recurringId">): boolean {
  return !task.recurringId;
}

/** Reopening (done → open/in progress) follows the same rule as closing: whoever may close it may reopen it. */
export function canChangeStatus(viewer: PublicUser, task: Pick<Task, "assigneeId" | "createdById" | "recurringId" | "status">, to: string, all: PublicUser[]): boolean {
  if (!canManage(viewer, task.assigneeId, all)) return false;
  if (to === "done" || task.status === "done") return canMarkDone(viewer, task, all);
  return true;
}
