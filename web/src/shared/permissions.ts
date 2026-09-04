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
