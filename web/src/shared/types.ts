export type Role = "admin" | "manager" | "employee";
export type TaskStatus = "open" | "in_progress" | "done";
export type TaskKind = "normal" | "leads";

/** A closed deal recorded on a leads task. */
export interface Deal {
  name: string;
  amount: number | null;
}
export type EventType = "created" | "status" | "note" | "edited" | "reassigned" | "deleted" | "photo" | "photo_removed";

export interface PublicUser {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  role: Role;
  managerId: number | null;
  sortOrder: number;
  active: boolean;
}

export interface Task {
  id: number;
  title: string;
  details: string;
  assigneeId: number;
  createdById: number;
  dueDate: string; // YYYY-MM-DD
  status: TaskStatus;
  progressNote: string;
  completedAt: string | null;
  completedDate: string | null;
  completedById: number | null;
  recurringId: number | null;
  kind: TaskKind;
  metricDeals: number | null;
  metricCalls: number | null;
  deals: Deal[]; // TODO(DND CASH): connect closed deals to the DND CASH system
  createdDate: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  deletedById: number | null;
  deleteReason: string | null;
  photoCount?: number;
}

export interface Attachment {
  id: number;
  taskId: number;
  uploadedById: number;
  fileName: string;
  contentType: string;
  size: number;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface TaskEvent {
  id: number;
  taskId: number;
  actorId: number;
  type: EventType;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  note: string;
  createdAt: string;
}

export interface RecurringTask {
  id: number;
  title: string;
  details: string;
  assigneeId: number;
  createdById: number;
  weekdays: number[]; // 0 = Sunday
  startDate: string;
  kind: TaskKind;
  active: boolean;
  createdAt: string;
}

export interface MeResponse {
  user: PublicUser;
  users: PublicUser[]; // whole team (names only for non-visible)
  visibleUserIds: number[]; // whose cards this user may open
  today: string; // YYYY-MM-DD in company timezone
}

export interface BoardResponse {
  date: string;
  today: string;
  tasks: Task[]; // only tasks of visible users
  upcoming: Task[]; // future tasks of visible users
  sent: Task[]; // tasks I created for teammates whose schedule I cannot see
}

export interface TaskDetailResponse {
  task: Task;
  events: TaskEvent[];
  attachments: Attachment[];
}

export interface LogEntry extends TaskEvent {
  taskTitle: string;
  taskAssigneeId: number;
}

export interface ApiError {
  error: string;
}
