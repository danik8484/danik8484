/** coordinator = "רכז": a regular team member (own board, direct manager) who also sees every non-admin, non-coordinator board and may add a task to anyone; on other people's cards they change nothing. */
export type Role = "admin" | "manager" | "employee" | "coordinator";
export type TaskStatus = "open" | "in_progress" | "done";
export type TaskKind = "normal" | "leads";
export type TaskPriority = "urgent" | "high" | "normal";

export const PAYMENT_METHODS = ["credit_card", "bank_transfer", "standing_order", "bank_standing_order", "cash", "crypto", "paypal"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  credit_card: "כרטיס אשראי",
  bank_transfer: "העברה בנקאית",
  standing_order: "הוראת קבע",
  bank_standing_order: "הוראת קבע בנקאית",
  cash: "מזומן",
  crypto: "קריפטו",
  paypal: "פייפאל",
};

/** A closed deal recorded on a leads task. All three fields are required. */
// TODO(DND CASH): sync these deals into the DND CASH system.
export interface Deal {
  name: string; // full customer name
  amount: number; // ₪
  method: PaymentMethod | ""; // "" only for legacy rows saved before the method existed
}

export interface DealRow extends Deal {
  taskId: number;
  date: string; // the leads task's date (YYYY-MM-DD)
  assigneeId: number;
}

export interface DealsResponse {
  from: string;
  to: string;
  deals: DealRow[];
  total: number;
  byMethod: Record<string, { count: number; amount: number }>;
}
export type EventType = "created" | "status" | "note" | "edited" | "reassigned" | "deleted" | "photo" | "photo_removed" | "reminder";

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
  priority: TaskPriority;
  reminderAt: string | null; // ISO instant; message every 30 min from then until done
  reminderLastSentAt: string | null;
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

/** Admin-editable integration settings, stored in the database (never in the repository). */
export interface AppSettings {
  telegramBotToken: string;
  telegramChatId: string;
  telegramNotifyOwnActions: boolean;
  /** "bridge": the company's own Baileys bridge (Green-API-compatible HTTP). "meta": WhatsApp Business Cloud API. */
  whatsappMode: "bridge" | "meta";
  bridgeHost: string; // e.g. https://wa-bridge.up.railway.app
  bridgeInstanceId: string; // waInstance id, e.g. 7107645253
  bridgeToken: string;
  whatsappToken: string;
  whatsappPhoneId: string;
  whatsappTemplate: string; // utility template with one {{1}} body parameter
  whatsappLoginTemplate: string; // authentication template (code in body + copy-code button)
  whatsappLang: string;
  /** Daily reminder time per weekday (0 = Sunday), "HH:MM" or "" for none. Saturday is the "plan the week" reminder. */
  reminderTimes: string[];
}

export interface AuthConfig {
  team: { id: number; name: string }[];
  whatsapp: boolean;
  email: boolean;
}
