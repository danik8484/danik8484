import type { AppSettings, Attachment, AuthConfig, BoardResponse, Deal, DealsResponse, LogEntry, MeResponse, PublicUser, RecurringTask, Task, TaskDetailResponse, TaskPriority, TaskStatus } from "@shared/types";

export type ClientSettings = AppSettings & { telegramConfigured: boolean; whatsappConfigured: boolean };

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string } & T;
  if (res.status === 401 && !url.startsWith("/api/auth/")) window.dispatchEvent(new Event("session-expired"));
  if (!res.ok) throw new ApiError(res.status, data.error || "שגיאה לא צפויה");
  return data as T;
}

export const api = {
  authConfig: () => request<AuthConfig>("GET", "/api/auth/config"),
  requestCode: (email: string) => request<{ ok: true; devCode?: string }>("POST", "/api/auth/request-code", { email }),
  requestUserCode: (userId: number) => request<{ ok: true; to: string; devCode?: string }>("POST", "/api/auth/request-code", { userId }),
  verifyCode: (email: string, code: string) => request<{ ok: true }>("POST", "/api/auth/verify", { email, code }),
  verifyUserCode: (userId: number, code: string) => request<{ ok: true }>("POST", "/api/auth/verify", { userId, code }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),
  loginWithLink: (token: string) => request<{ ok: true }>("POST", "/api/auth/link", { token }),
  loginLink: (userId: number) => request<{ ok: true; url: string; expiresAt: number }>("POST", `/api/users/${userId}/login-link`),
  me: () => request<MeResponse>("GET", "/api/me"),
  board: (date: string) => request<BoardResponse>("GET", `/api/tasks/board?date=${date}`),
  task: (id: number) => request<TaskDetailResponse>("GET", `/api/tasks/${id}`),
  createTask: (input: { title: string; details: string; assigneeId: number; dueDate: string; weekdays?: number[]; kind?: "normal" | "leads"; priority?: TaskPriority; notifyNow?: boolean }) =>
    request<{ ok: true; task?: Task; recurringId?: number }>("POST", "/api/tasks", input),
  updateTask: (id: number, input: { title?: string; details?: string; dueDate?: string; assigneeId?: number; priority?: TaskPriority }) =>
    request<{ ok: true; task: Task }>("PATCH", `/api/tasks/${id}`, input),
  setStatus: (id: number, status: TaskStatus, note: string, metrics?: { deals?: Deal[]; metricCalls?: number | null }) =>
    request<{ ok: true; task: Task }>("POST", `/api/tasks/${id}/status`, { status, note, ...(metrics ?? {}) }),
  deleteTask: (id: number, reason: string) => request<{ ok: true }>("DELETE", `/api/tasks/${id}`, { reason }),
  setReminder: (id: number, reminderAt: string | null) => request<{ ok: true; task: Task }>("POST", `/api/tasks/${id}/reminder`, { reminderAt }),
  settings: () => request<ClientSettings>("GET", "/api/settings"),
  saveSettings: (input: Partial<AppSettings>) => request<{ ok: true; settings: ClientSettings }>("PUT", "/api/settings", input),
  resetReminders: () => request<{ ok: true; settings: ClientSettings }>("POST", "/api/settings/reset-reminders"),
  telegramChats: () => request<{ chats: { id: string; name: string }[] }>("GET", "/api/settings/telegram/chats"),
  telegramTest: () => request<{ ok: true }>("POST", "/api/settings/telegram/test"),
  whatsappTest: (phone?: string) => request<{ ok: true }>("POST", "/api/settings/whatsapp/test", { phone }),
  uploadPhoto: async (taskId: number, blob: Blob, name: string, width: number, height: number) => {
    const res = await fetch(`/api/tasks/${taskId}/photos`, {
      method: "POST",
      headers: {
        "content-type": blob.type || "image/jpeg",
        "x-file-name": encodeURIComponent(name),
        ...(width ? { "x-image-width": String(width), "x-image-height": String(height) } : {}),
      },
      body: blob,
      credentials: "same-origin",
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string; attachment?: Attachment };
    if (!res.ok) throw new ApiError(res.status, data.error || "העלאה נכשלה");
    return data.attachment as Attachment;
  },
  uploadThumb: async (photoId: number, blob: Blob) => {
    await fetch(`/api/photos/${photoId}/thumb`, { method: "POST", headers: { "content-type": "image/jpeg" }, body: blob, credentials: "same-origin" }).catch(() => undefined);
  },
  deletePhoto: (id: number) => request<{ ok: true }>("DELETE", `/api/photos/${id}`),
  pushConfig: () => request<{ publicKey: string; devices: number }>("GET", "/api/push/config"),
  pushSubscribe: (sub: { endpoint: string; keys: { p256dh: string; auth: string } }) => request<{ ok: true }>("POST", "/api/push/subscribe", sub),
  pushUnsubscribe: (endpoint: string) => request<{ ok: true }>("POST", "/api/push/unsubscribe", { endpoint }),
  pushTest: () => request<{ ok: true; delivered: number }>("POST", "/api/push/test"),
  deals: (from: string, to: string, userId?: number) => request<DealsResponse>("GET", `/api/deals?from=${from}&to=${to}${userId ? `&userId=${userId}` : ""}`),
  log: (from: string, to: string) => request<{ from: string; to: string; entries: LogEntry[] }>("GET", `/api/log?from=${from}&to=${to}`),
  recurring: () => request<{ recurring: RecurringTask[] }>("GET", "/api/recurring"),
  updateRecurring: (id: number, input: { title?: string; details?: string; weekdays?: number[]; active?: boolean; kind?: "normal" | "leads" }) =>
    request<{ ok: true; recurring: RecurringTask }>("PATCH", `/api/recurring/${id}`, input),
  deleteRecurring: (id: number, reason: string) => request<{ ok: true }>("DELETE", `/api/recurring/${id}`, { reason }),
  users: () => request<{ users: PublicUser[] }>("GET", "/api/users"),
  createUser: (input: { name: string; email: string | null; phone: string | null; role: string; managerId: number | null }) =>
    request<{ ok: true; user: PublicUser }>("POST", "/api/users", input),
  updateUser: (id: number, input: Partial<{ name: string; email: string | null; phone: string | null; role: string; managerId: number | null; active: boolean; sortOrder: number }>) =>
    request<{ ok: true; user: PublicUser }>("PATCH", `/api/users/${id}`, input),
};
