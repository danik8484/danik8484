import type { BoardResponse, LogEntry, MeResponse, PublicUser, RecurringTask, Task, TaskDetailResponse, TaskStatus } from "@shared/types";

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
  if (!res.ok) throw new ApiError(res.status, data.error || "שגיאה לא צפויה");
  return data as T;
}

export const api = {
  requestCode: (email: string) => request<{ ok: true; devCode?: string }>("POST", "/api/auth/request-code", { email }),
  verifyCode: (email: string, code: string) => request<{ ok: true }>("POST", "/api/auth/verify", { email, code }),
  logout: () => request<{ ok: true }>("POST", "/api/auth/logout"),
  me: () => request<MeResponse>("GET", "/api/me"),
  board: (date: string) => request<BoardResponse & { upcoming: Task[] }>("GET", `/api/tasks/board?date=${date}`),
  task: (id: number) => request<TaskDetailResponse>("GET", `/api/tasks/${id}`),
  createTask: (input: { title: string; details: string; assigneeId: number; dueDate: string; weekdays?: number[] }) =>
    request<{ ok: true; task?: Task; recurringId?: number }>("POST", "/api/tasks", input),
  updateTask: (id: number, input: { title?: string; details?: string; dueDate?: string; assigneeId?: number }) =>
    request<{ ok: true; task: Task }>("PATCH", `/api/tasks/${id}`, input),
  setStatus: (id: number, status: TaskStatus, note: string) => request<{ ok: true; task: Task }>("POST", `/api/tasks/${id}/status`, { status, note }),
  deleteTask: (id: number, reason: string) => request<{ ok: true }>("DELETE", `/api/tasks/${id}`, { reason }),
  log: (from: string, to: string) => request<{ from: string; to: string; entries: LogEntry[] }>("GET", `/api/log?from=${from}&to=${to}`),
  recurring: () => request<{ recurring: RecurringTask[] }>("GET", "/api/recurring"),
  updateRecurring: (id: number, input: { title?: string; details?: string; weekdays?: number[]; active?: boolean }) =>
    request<{ ok: true; recurring: RecurringTask }>("PATCH", `/api/recurring/${id}`, input),
  deleteRecurring: (id: number, reason: string) => request<{ ok: true }>("DELETE", `/api/recurring/${id}`, { reason }),
  users: () => request<{ users: PublicUser[] }>("GET", "/api/users"),
  createUser: (input: { name: string; email: string | null; role: string; managerId: number | null }) =>
    request<{ ok: true; user: PublicUser }>("POST", "/api/users", input),
  updateUser: (id: number, input: Partial<{ name: string; email: string | null; role: string; managerId: number | null; active: boolean; sortOrder: number }>) =>
    request<{ ok: true; user: PublicUser }>("PATCH", `/api/users/${id}`, input),
};
