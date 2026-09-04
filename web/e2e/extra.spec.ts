import { test, expect, type Browser, type Page, type APIRequestContext } from "@playwright/test";

async function login(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByLabel("כתובת מייל").fill(email);
  await page.getByRole("button", { name: "שלח לי קוד" }).click();
  await expect(page.getByTestId("dev-code").or(page.locator(".bg-red-50"))).toBeVisible();
  const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
  await page.getByLabel("קוד כניסה").fill(code);
  await page.getByRole("button", { name: "כניסה" }).click();
  await expect(page.getByTestId("card-1")).toBeVisible();
  return page;
}

async function apiLogin(request: APIRequestContext, email: string) {
  const r = await request.post("/api/auth/request-code", { data: { email } });
  const { devCode } = await r.json();
  const v = await request.post("/api/auth/verify", { data: { email, code: devCode } });
  expect(v.ok()).toBeTruthy();
}

function shiftDate(iso: string, days: number) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test("admin user management guards", async ({ browser }) => {
  const page = await login(browser, "dani@example.com");
  await page.getByRole("button", { name: "תפריט" }).click();
  await page.getByRole("link", { name: "משתמשים" }).click();
  await expect(page.getByText("ron@example.com")).toBeVisible();

  // Ron still manages Uri Shapira → cannot be demoted to employee
  await page.locator("li", { hasText: /^רון וליצ'קו/ }).getByRole("button", { name: "עריכה" }).click();
  await page.getByLabel("תפקיד").selectOption("employee");
  await page.getByLabel("מנהל ישיר").selectOption("1");
  await page.getByRole("button", { name: "שמירה" }).click();
  await expect(page.getByText(/לא ניתן להפוך לעובד/)).toBeVisible();
  await page.getByRole("button", { name: "ביטול" }).click();

  // Changing an email works and is reflected in the list
  await page.locator("li", { hasText: /^דני קגנוביץ/ }).getByRole("button", { name: "עריכה" }).click();
  await page.getByLabel("מייל לכניסה").fill("dani.k2@example.com");
  await page.getByRole("button", { name: "שמירה" }).click();
  await expect(page.getByText("dani.k2@example.com")).toBeVisible();
  await page.locator("li", { hasText: /^דני קגנוביץ/ }).getByRole("button", { name: "עריכה" }).click();
  await page.getByLabel("מייל לכניסה").fill("dani.k@example.com");
  await page.getByRole("button", { name: "שמירה" }).click();
  await expect(page.getByText("dani.k@example.com")).toBeVisible();
  await page.context().close();
});

test("past-day view shows tasks as they were on that day", async ({ browser, request }) => {
  await apiLogin(request, "dani@example.com");
  const me = await (await request.get("/api/me")).json();
  const today: string = me.today;
  const yesterday = shiftDate(today, -1);
  const title = `משימה מאתמול ${Date.now().toString().slice(-6)}`;
  const created = await (await request.post("/api/tasks", { data: { title, assigneeId: 5, dueDate: yesterday } })).json();
  const done = await request.post(`/api/tasks/${created.task.id}/status`, { data: { status: "done", note: "" } });
  expect(done.ok()).toBeTruthy();

  const page = await login(browser, "dani@example.com");
  // Today: completed
  const rowToday = page.getByTestId(`task-${created.task.id}`);
  await expect(rowToday).toBeVisible();
  await expect(rowToday.getByText("הושלם", { exact: false })).toBeVisible();
  await expect(page.getByTestId("summary")).toBeVisible();

  // Yesterday: the task was created today, so it does not exist on yesterday's board at all
  await page.getByRole("button", { name: "יום קודם" }).click();
  await expect(page.getByText(yesterday.slice(8, 10).replace(/^0/, ""), { exact: false }).first()).toBeVisible();
  await expect(page.getByTestId(`task-${created.task.id}`)).toHaveCount(0);
  await page.getByRole("button", { name: "חזרה להיום" }).click();
  await expect(rowToday).toBeVisible();
  await page.context().close();
});

test("employee cannot touch other people's tasks through the API", async ({ request }) => {
  await apiLogin(request, "dani@example.com");
  const created = await (await request.post("/api/tasks", { data: { title: "משימה לרון", assigneeId: 2, dueDate: "2030-01-01" } })).json();
  const id = created.task.id;

  const ctx = await request.post("/api/auth/logout");
  expect(ctx.ok()).toBeTruthy();
  await apiLogin(request, "uri.h@example.com");
  expect((await request.get(`/api/tasks/${id}`)).status()).toBe(403);
  expect((await request.post(`/api/tasks/${id}/status`, { data: { status: "done", note: "" } })).status()).toBe(403);
  expect((await request.patch(`/api/tasks/${id}`, { data: { title: "x" } })).status()).toBe(403);
  expect((await request.delete(`/api/tasks/${id}`, { data: { reason: "בדיקה" } })).status()).toBe(403);
  // Deleting without a reason is rejected even on own tasks
  const own = await (await request.post("/api/tasks", { data: { title: "שלי", assigneeId: 5, dueDate: "2030-01-01" } })).json();
  expect((await request.delete(`/api/tasks/${own.task.id}`, { data: {} })).status()).toBe(400);
  // In-progress without a note is rejected
  expect((await request.post(`/api/tasks/${own.task.id}/status`, { data: { status: "in_progress", note: "" } })).status()).toBe(400);
  expect((await request.delete(`/api/tasks/${own.task.id}`, { data: { reason: "ניקוי בדיקות" } })).status()).toBe(200);
});
