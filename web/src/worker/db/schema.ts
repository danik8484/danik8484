import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

const nowIso = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").unique(),
  phone: text("phone"),
  role: text("role", { enum: ["admin", "manager", "employee"] }).notNull(),
  managerId: integer("manager_id"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: integer("active").notNull().default(1),
  reminderSentDate: text("reminder_sent_date"),
  createdAt: text("created_at").notNull().default(nowIso),
});

export const loginCodes = sqliteTable(
  "login_codes",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    used: integer("used").notNull().default(0),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("login_codes_email_idx").on(t.email, t.createdAt)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: integer("user_id").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const recurringTasks = sqliteTable("recurring_tasks", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  details: text("details").notNull().default(""),
  assigneeId: integer("assignee_id").notNull(),
  createdById: integer("created_by_id").notNull(),
  weekdays: text("weekdays").notNull(),
  startDate: text("start_date").notNull(),
  kind: text("kind", { enum: ["normal", "leads"] }).notNull().default("normal"),
  active: integer("active").notNull().default(1),
  deletedAt: text("deleted_at"),
  deletedById: integer("deleted_by_id"),
  deleteReason: text("delete_reason"),
  createdAt: text("created_at").notNull().default(nowIso),
});

export const tasks = sqliteTable(
  "tasks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    title: text("title").notNull(),
    details: text("details").notNull().default(""),
    assigneeId: integer("assignee_id").notNull(),
    createdById: integer("created_by_id").notNull(),
    dueDate: text("due_date").notNull(),
    status: text("status", { enum: ["open", "in_progress", "done"] }).notNull().default("open"),
    progressNote: text("progress_note").notNull().default(""),
    completedAt: text("completed_at"),
    completedDate: text("completed_date"),
    completedById: integer("completed_by_id"),
    recurringId: integer("recurring_id"),
    kind: text("kind", { enum: ["normal", "leads"] }).notNull().default("normal"),
    metricDeals: integer("metric_deals"),
    metricCalls: integer("metric_calls"),
    dealsJson: text("deals_json"),
    deletedAt: text("deleted_at"),
    deletedById: integer("deleted_by_id"),
    deleteReason: text("delete_reason"),
    createdDate: text("created_date").notNull(),
    createdAt: text("created_at").notNull().default(nowIso),
    updatedAt: text("updated_at").notNull().default(nowIso),
  },
  (t) => [
    uniqueIndex("tasks_recurring_unique").on(t.recurringId, t.dueDate),
    index("tasks_assignee_due_idx").on(t.assigneeId, t.dueDate),
    index("tasks_status_idx").on(t.status),
  ],
);

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull(),
    actorId: integer("actor_id").notNull(),
    type: text("type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull().default(nowIso),
  },
  (t) => [index("task_events_task_idx").on(t.taskId), index("task_events_created_idx").on(t.createdAt)],
);

export type UserRow = typeof users.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskEventRow = typeof taskEvents.$inferSelect;
export type RecurringRow = typeof recurringTasks.$inferSelect;

export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const loginLinks = sqliteTable("login_links", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  tokenHash: text("token_hash").notNull().unique(),
  userId: integer("user_id").notNull(),
  createdById: integer("created_by_id"),
  expiresAt: integer("expires_at").notNull(),
  usedAt: integer("used_at"),
  createdAt: integer("created_at").notNull(),
});

export const taskAttachments = sqliteTable(
  "task_attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    taskId: integer("task_id").notNull(),
    uploadedById: integer("uploaded_by_id").notNull(),
    kvKey: text("kv_key").notNull().unique(),
    thumbKey: text("thumb_key"),
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    width: integer("width"),
    height: integer("height"),
    deletedAt: text("deleted_at"),
    deletedById: integer("deleted_by_id"),
    createdAt: text("created_at").notNull().default(nowIso),
  },
  (t) => [index("task_attachments_task_idx").on(t.taskId)],
);
export type AttachmentRow = typeof taskAttachments.$inferSelect;

export const pushSubscriptions = sqliteTable(
  "push_subscriptions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    endpoint: text("endpoint").notNull().unique(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    userAgent: text("user_agent").notNull().default(""),
    sessionId: text("session_id"),
    failures: integer("failures").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull().default(nowIso),
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

export const notificationQueue = sqliteTable(
  "notification_queue",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    userId: integer("user_id").notNull(),
    actorId: integer("actor_id").notNull(),
    taskId: integer("task_id").notNull(),
    createdAt: integer("created_at").notNull(),
    sentAt: integer("sent_at"),
  },
  (t) => [index("notification_queue_pending_idx").on(t.sentAt, t.userId)],
);
