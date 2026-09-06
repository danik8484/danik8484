import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/** Push, reminder loops with a chosen interval, the four board sections, and the morning report. */
const ADMIN = 1;
const URI_H = 5;
const tag = Date.now().toString().slice(-6);

async function apiLogin(request: APIRequestContext, userId: number) {
  await request.post("/api/auth/logout");
  const r = await request.post("/api/auth/request-code", { data: { userId } });
  const { devCode } = await r.json();
  expect(devCode, `dev code for user ${userId}`).toBeTruthy();
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

async function today(request: APIRequestContext): Promise<string> {
  return (await (await request.get("/api/me")).json()).today;
}

async function pending(request: APIRequestContext): Promise<number> {
  return (await (await request.get("/api/push/pending")).json()).pending;
}

async function cron(request: APIRequestContext) {
  expect((await request.get("/__scheduled?cron=force")).ok()).toBeTruthy();
}

test("push: whoever gave the task sends it again now – not the person themselves, not twice in two minutes, not when done", async ({ request }) => {
  await apiLogin(request, ADMIN);
  const d = await today(request);
  const id = (await (await request.post("/api/tasks", { data: { title: `פוש ${tag}`, assigneeId: URI_H, dueDate: d } })).json()).task.id;
  // the person themselves cannot push their own task
  await apiLogin(request, URI_H);
  expect((await request.post(`/api/tasks/${id}/nudge`)).status()).toBe(400);
  const before = await pending(request);
  // the admin (who gave it) can; in this environment Uri has no device or WhatsApp, so it lands in the digest queue
  await apiLogin(request, ADMIN);
  const r = await request.post(`/api/tasks/${id}/nudge`);
  expect(r.ok()).toBeTruthy();
  expect((await r.json()).delivered).toBe("none");
  expect((await request.post(`/api/tasks/${id}/nudge`)).status()).toBe(429);
  const detail = await (await request.get(`/api/tasks/${id}`)).json();
  expect(detail.events.some((e: { type: string; note: string }) => e.type === "reminder" && e.note.startsWith("פוש"))).toBeTruthy();
  await apiLogin(request, URI_H);
  expect(await pending(request)).toBe(before + 1);
  // someone who cannot open the task cannot push it
  await apiLogin(request, 3);
  expect((await request.post(`/api/tasks/${id}/nudge`)).status()).toBe(403);
  // a finished task is not pushed
  await apiLogin(request, ADMIN);
  expect((await request.post(`/api/tasks/${id}/status`, { data: { status: "done", note: "" } })).ok()).toBeTruthy();
  expect((await request.post(`/api/tasks/${id}/nudge`)).status()).toBe(400);
});

test("reminder loop: the interval is chosen from the list and shows on the task and in its history", async ({ request }) => {
  await apiLogin(request, ADMIN);
  const d = await today(request);
  const id = (await (await request.post("/api/tasks", { data: { title: `לופ ${tag}`, assigneeId: URI_H, dueDate: d } })).json()).task.id;
  const soon = new Date(Date.now() + 3600e3).toISOString();
  expect((await request.post(`/api/tasks/${id}/reminder`, { data: { reminderAt: soon, everyMin: 45 } })).status()).toBe(400);
  const set = await (await request.post(`/api/tasks/${id}/reminder`, { data: { reminderAt: soon, everyMin: 60 } })).json();
  expect(set.task.reminderEveryMin).toBe(60);
  const daily = await (await request.post(`/api/tasks/${id}/reminder`, { data: { reminderAt: soon, everyMin: 1440 } })).json();
  expect(daily.task.reminderEveryMin).toBe(1440);
  const noInterval = await (await request.post(`/api/tasks/${id}/reminder`, { data: { reminderAt: soon } })).json();
  expect(noInterval.task.reminderEveryMin).toBe(30); // the old spacing when nothing is chosen
  const detail = await (await request.get(`/api/tasks/${id}`)).json();
  const notes = detail.events.filter((e: { type: string }) => e.type === "reminder").map((e: { note: string }) => e.note);
  expect(notes.some((n: string) => n.includes("כל שעה"))).toBeTruthy();
  expect(notes.some((n: string) => n.includes("כל פעם ביום"))).toBeTruthy();
  // clearing the reminder clears the interval too
  const cleared = await (await request.post(`/api/tasks/${id}/reminder`, { data: { reminderAt: null } })).json();
  expect(cleared.task.reminderAt).toBeNull();
  expect(cleared.task.reminderEveryMin).toBeNull();
});

test("the board groups a card into urgent · daily · new · done, with clear headers", async ({ browser, request }) => {
  await apiLogin(request, ADMIN);
  const d = await today(request);
  const mk = async (data: Record<string, unknown>) => (await (await request.post("/api/tasks", { data: { assigneeId: ADMIN, dueDate: d, ...data } })).json());
  const urgent = (await mk({ title: `דחופה ${tag}`, priority: "urgent" })).task.id;
  const normal = (await mk({ title: `רגילה ${tag}` })).task.id;
  const doneId = (await mk({ title: `גמורה ${tag}` })).task.id;
  expect((await request.post(`/api/tasks/${doneId}/status`, { data: { status: "done", note: "" } })).ok()).toBeTruthy();
  const rec = await mk({ title: `יומית ${tag}`, weekdays: [0, 1, 2, 3, 4, 5, 6] });
  const templateId = rec.recurringId;

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await uiLogin(page, "דני שקנבסקי");
  const card = page.getByTestId("card-1");
  await expect(card.getByText("🚨 משימות דחופות")).toBeVisible();
  await expect(card.getByText("🔁 משימות יומיות")).toBeVisible();
  await expect(card.getByText("🆕 משימות חדשות")).toBeVisible();
  await expect(card.getByText("✅ הושלמו")).toBeVisible();
  await expect(page.getByTestId("group-urgent-1").getByText(`דחופה ${tag}`)).toBeVisible();
  await expect(page.getByTestId("group-daily-1").getByText(`יומית ${tag}`)).toBeVisible();
  await expect(page.getByTestId("group-new-1").getByText(`רגילה ${tag}`)).toBeVisible();
  await expect(page.getByTestId("group-done-1").getByText(`גמורה ${tag}`)).toBeVisible();
  // the old small sub-headers are gone
  await expect(card.getByText("מההנהלה")).toHaveCount(0);
  await ctx.close();

  expect((await request.delete(`/api/recurring/${templateId}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
  for (const id of [urgent, normal, doneId]) expect((await request.delete(`/api/tasks/${id}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
});

test("morning report: once a day (not on Saturday), each person's open tasks for today, urgent first", async ({ request }) => {
  await apiLogin(request, ADMIN);
  const d = await today(request);
  test.skip(new Date(d + "T00:00:00Z").getUTCDay() === 6, "no morning report on Saturday");
  expect((await request.put("/api/settings", { data: { morningReportTime: "25:99" } })).status()).toBe(400);
  expect((await request.put("/api/settings", { data: { morningReportTime: "00:01" } })).ok()).toBeTruthy();
  const a = (await (await request.post("/api/tasks", { data: { title: `בוקר רגילה ${tag}`, assigneeId: URI_H, dueDate: d } })).json()).task.id;
  const b = (await (await request.post("/api/tasks", { data: { title: `בוקר דחופה ${tag}`, assigneeId: URI_H, dueDate: d, priority: "urgent" } })).json()).task.id;
  const before = await (await request.get("/api/settings/morning-report/preview")).json();
  const uriBefore = before.people.find((p: { userId: number }) => p.userId === URI_H);
  expect(uriBefore.lines.some((l: string) => l.includes(`בוקר רגילה ${tag}`))).toBeTruthy();
  expect(uriBefore.lines.findIndex((l: string) => l.includes(`בוקר דחופה ${tag}`))).toBeLessThan(uriBefore.lines.findIndex((l: string) => l.includes(`בוקר רגילה ${tag}`)));
  expect(uriBefore.lines.find((l: string) => l.includes(`בוקר רגילה ${tag}`))).toContain("מאת דני");
  await cron(request);
  const after = await (await request.get("/api/settings/morning-report/preview")).json();
  expect(after.people.find((p: { userId: number }) => p.userId === URI_H).sentToday).toBeTruthy();
  expect(after.time).toBe("00:01");
  for (const id of [a, b]) expect((await request.delete(`/api/tasks/${id}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
  expect((await request.put("/api/settings", { data: { morningReportTime: "10:00" } })).ok()).toBeTruthy();
});

test("in the browser: the push button and the interval picker are there", async ({ browser, request }) => {
  await apiLogin(request, ADMIN);
  const d = await today(request);
  const id = (await (await request.post("/api/tasks", { data: { title: `כפתורים ${tag}`, assigneeId: URI_H, dueDate: d } })).json()).task.id;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await uiLogin(page, "דני שקנבסקי");
  await page.getByTestId(`task-${id}`).first().click();
  await expect(page.getByTestId("nudge")).toBeVisible();
  await page.getByTestId("nudge-button").click();
  await expect(page.getByTestId("nudge-button")).toHaveText("נשלח ✓");
  await page.getByRole("button", { name: "הוספת תזכורת" }).click();
  await expect(page.getByTestId("reminder-every")).toBeVisible();
  await page.getByTestId("reminder-every").selectOption("120");
  await page.getByRole("button", { name: "שמירה", exact: true }).click();
  await expect(page.getByTestId("reminder").getByText(/כל שעתיים/)).toBeVisible();
  await ctx.close();
  expect((await request.delete(`/api/tasks/${id}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
});
