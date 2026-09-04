import { test, expect, type APIRequestContext } from "@playwright/test";

async function apiLogin(request: APIRequestContext, email: string) {
  const r = await request.post("/api/auth/request-code", { data: { email } });
  const { devCode } = await r.json();
  expect((await request.post("/api/auth/verify", { data: { email, code: devCode } })).ok()).toBeTruthy();
}
function shift(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const has = (list: { id: number }[], id: number) => list.some((t) => t.id === id);

test("tasks never vanish: overdue ones carry over, finished ones stay until their completion day", async ({ request }) => {
  await apiLogin(request, "dani@example.com");
  const { today } = await (await request.get("/api/me")).json();
  const y1 = shift(today, -1), y3 = shift(today, -3), t2 = shift(today, 2);
  const mk = async (title: string, dueDate: string) => (await (await request.post("/api/tasks", { data: { title, assigneeId: 4, dueDate } })).json()).task.id;
  const overdue = await mk("נגררת מלפני 3 ימים", y3);
  const early = await mk("הושלמה לפני הזמן", t2);
  const future = await mk("עתידית", t2);
  const doneToday = await mk("הושלמה היום", y1);

  expect((await request.post(`/api/tasks/${early}/status`, { data: { status: "done", note: "" } })).ok()).toBeTruthy();
  expect((await request.post(`/api/tasks/${doneToday}/status`, { data: { status: "done", note: "" } })).ok()).toBeTruthy();

  const board = async (d: string) => (await request.get(`/api/tasks/board?date=${d}`)).json();
  const now = await board(today);
  expect(has(now.tasks, overdue)).toBeTruthy(); // open, due 3 days ago → still on today's board
  expect(has(now.tasks, doneToday)).toBeTruthy(); // finished today → shown today as done
  expect(has(now.tasks, early)).toBeTruthy(); // completed early → visible today (completion day)
  expect(has(now.upcoming, future)).toBeTruthy();
  expect(has(now.upcoming, early)).toBeFalsy();

  const inTwoDays = await board(t2);
  expect(has(inTwoDays.tasks, early)).toBeTruthy(); // ...and on its due date
  expect(has(inTwoDays.tasks, future)).toBeTruthy();
  expect(has(inTwoDays.tasks, overdue)).toBeTruthy(); // still open → still carried over
  expect(has(inTwoDays.tasks, doneToday)).toBeFalsy(); // done before that day → no longer listed

  const yesterday = await board(y1);
  // created today → not part of yesterday's board at all
  expect(has(yesterday.tasks, overdue)).toBeFalsy();
  expect(has(yesterday.tasks, doneToday)).toBeFalsy();

  // Deleted tasks leave the board but stay reachable with their reason
  expect((await request.delete(`/api/tasks/${future}`, { data: { reason: "בדיקת מחיקה" } })).ok()).toBeTruthy();
  expect(has((await board(t2)).tasks, future)).toBeFalsy();
  const detail = await (await request.get(`/api/tasks/${future}`)).json();
  expect(detail.task.deleteReason).toBe("בדיקת מחיקה");
  const log = await (await request.get(`/api/log?from=${today}&to=${today}`)).json();
  expect(log.entries.some((e: { taskId: number; type: string }) => e.taskId === future && e.type === "deleted")).toBeTruthy();
});
