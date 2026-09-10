import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/** The shared call list: add → take (a task with a reminder) → done / release / delete. */
const ADMIN = 1;
const RON = 2;
const URI_S = 3;
const URI_H = 5;
const tag = Date.now().toString().slice(-6);

async function apiLogin(request: APIRequestContext, userId: number) {
  await request.post("/api/auth/logout");
  const { devCode } = await (await request.post("/api/auth/request-code", { data: { userId } })).json();
  expect((await request.post("/api/auth/verify", { data: { userId, code: devCode } })).ok()).toBeTruthy();
}

async function uiLogin(page: Page, name: string) {
  await page.goto("/");
  await page.getByTestId("team-picker").getByRole("button", { name, exact: true }).click();
  await page.getByRole("button", { name: "שלח לי קוד לוואטסאפ" }).click();
  await expect(page.getByTestId("dev-code")).toBeVisible();
  const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
  await page.getByLabel("קוד אימות").fill(code);
  await page.getByRole("button", { name: "כניסה" }).click();
}

const tomorrowAt = (hh: number) => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hh, 30, 0, 0);
  return d;
};

test("add → take (task + reminder) → done keeps the row and the task in step; another employee cannot touch it", async ({ request }) => {
  await apiLogin(request, URI_H);
  expect((await request.post("/api/calls", { data: { name: "", phone: "" } })).status()).toBe(400);
  expect((await request.post("/api/calls", { data: { name: "משה לוי", phone: "12" } })).status()).toBe(400);
  const item = (await (await request.post("/api/calls", { data: { name: `משה לוי ${tag}`, phone: "050-123-4567", note: "מתעניין באימונים" } })).json()).item;
  expect(item.status).toBe("open");
  expect(item.phone).toBe("0501234567");
  // Ron takes it for tomorrow 14:30
  await apiLogin(request, RON);
  const at = tomorrowAt(14);
  expect((await request.post(`/api/calls/${item.id}/take`, { data: { at: "not-a-date" } })).status()).toBe(400);
  const taken = await (await request.post(`/api/calls/${item.id}/take`, { data: { at: at.toISOString() } })).json();
  expect(taken.item.status).toBe("scheduled");
  expect(taken.item.takenById).toBe(RON);
  expect(taken.task.assigneeId).toBe(RON);
  expect(taken.task.title).toContain(`שיחה עם משה לוי ${tag}`);
  expect(taken.task.title).toContain("14:30");
  expect(taken.task.reminderAt).toBe(at.toISOString());
  expect(taken.task.reminderEveryMin).toBe(60);
  expect(taken.task.details).toContain("0501234567");
  // someone else cannot take, release or finish it
  await apiLogin(request, URI_S);
  expect((await request.post(`/api/calls/${item.id}/take`, { data: { at: at.toISOString() } })).status()).toBe(409);
  expect((await request.post(`/api/calls/${item.id}/release`)).status()).toBe(403);
  expect((await request.post(`/api/calls/${item.id}/done`)).status()).toBe(403);
  // Ron marks the task done on his board → the row is done
  await apiLogin(request, RON);
  expect((await request.post(`/api/tasks/${taken.task.id}/status`, { data: { status: "done", note: "" } })).ok()).toBeTruthy();
  const list = await (await request.get("/api/calls")).json();
  expect(list.items.some((i: { id: number }) => i.id === item.id)).toBeFalsy();
  expect(list.done.find((i: { id: number }) => i.id === item.id)?.status).toBe("done");
  // reopening the task brings the row back to "scheduled"
  expect((await request.post(`/api/tasks/${taken.task.id}/status`, { data: { status: "open", note: "" } })).ok()).toBeTruthy();
  const again = await (await request.get("/api/calls")).json();
  expect(again.items.find((i: { id: number }) => i.id === item.id)?.status).toBe("scheduled");
  // and "בוצע" from the list closes both
  expect((await request.post(`/api/calls/${item.id}/done`)).ok()).toBeTruthy();
  expect((await (await request.get(`/api/tasks/${taken.task.id}`)).json()).task.status).toBe("done");
});

test("release puts the row back and removes the task; delete rights; a deleted task releases the row", async ({ request }) => {
  await apiLogin(request, URI_H);
  const a = (await (await request.post("/api/calls", { data: { name: `דנה כהן ${tag}` } })).json()).item;
  const b = (await (await request.post("/api/calls", { data: { name: `יוסי בר ${tag}` } })).json()).item;
  await apiLogin(request, RON);
  const tA = (await (await request.post(`/api/calls/${a.id}/take`, { data: { at: tomorrowAt(10).toISOString() } })).json()).task;
  const tB = (await (await request.post(`/api/calls/${b.id}/take`, { data: { at: tomorrowAt(11).toISOString() } })).json()).task;
  // release A: back to open, its task is gone
  expect((await request.post(`/api/calls/${a.id}/release`)).ok()).toBeTruthy();
  expect((await (await request.get(`/api/tasks/${tA.id}`)).json()).task.deletedAt).toBeTruthy();
  let list = await (await request.get("/api/calls")).json();
  expect(list.items.find((i: { id: number }) => i.id === a.id)).toMatchObject({ status: "open", takenById: null, taskId: null });
  // deleting B's task from the board releases B
  expect((await request.delete(`/api/tasks/${tB.id}`, { data: { reason: "לא רלוונטי" } })).ok()).toBeTruthy();
  list = await (await request.get("/api/calls")).json();
  expect(list.items.find((i: { id: number }) => i.id === b.id)?.status).toBe("open");
  // delete rights: another employee no, the one who added it yes
  await apiLogin(request, URI_S);
  expect((await request.delete(`/api/calls/${a.id}`)).status()).toBe(403);
  await apiLogin(request, URI_H);
  expect((await request.delete(`/api/calls/${a.id}`)).ok()).toBeTruthy();
  await apiLogin(request, ADMIN);
  expect((await request.delete(`/api/calls/${b.id}`)).ok()).toBeTruthy();
  list = await (await request.get("/api/calls")).json();
  expect(list.items.some((i: { id: number }) => i.id === a.id || i.id === b.id)).toBeFalsy();
});

test("in the browser: Ron adds a person, takes the call, sees it under 'נקבעו' and on his board", async ({ browser, request }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await uiLogin(page, "רון וליצ'קו");
  await expect(page.getByTestId("card-2")).toBeVisible();
  await page.goto("/calls");
  await expect(page.getByText("רשימת שיחות משותפת")).toBeVisible();
  await page.getByTestId("call-add-name").fill(`אבי גל ${tag}`);
  await page.getByTestId("call-add-phone").fill("052-999-8877");
  await page.getByTestId("call-add-submit").click();
  const row = page.locator('[data-testid^="call-"]', { hasText: `אבי גל ${tag}` }).first();
  await expect(row).toBeVisible();
  const id = (await row.getAttribute("data-testid"))!.replace("call-", "");
  await page.getByTestId(`call-take-${id}`).click();
  const d = tomorrowAt(16);
  const pad = (n: number) => String(n).padStart(2, "0");
  await page.getByTestId(`call-when-${id}`).fill(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T16:30`);
  await page.getByTestId(`call-confirm-${id}`).click();
  await expect(page.getByTestId(`call-sched-${id}`)).toContainText("רון");
  await expect(page.getByTestId(`call-sched-${id}`)).toContainText("16:30");
  await ctx.close();
  await apiLogin(request, RON);
  const list = await (await request.get("/api/calls")).json();
  const item = list.items.find((i: { id: number }) => i.id === Number(id));
  expect(item.status).toBe("scheduled");
  const t = await (await request.get(`/api/tasks/${item.taskId}`)).json();
  expect(t.task.title).toContain(`שיחה עם אבי גל ${tag}`);
  expect((await request.post(`/api/calls/${id}/done`)).ok()).toBeTruthy();
});
