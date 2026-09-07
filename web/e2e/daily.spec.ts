import { test, expect, type APIRequestContext, type Page } from "@playwright/test";
import { execSync } from "node:child_process";

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

test("clarify: the person the task belongs to asks whoever gave it – not the giver, not twice in two minutes, not when done", async ({ request }) => {
  await apiLogin(request, ADMIN);
  const d = await today(request);
  const id = (await (await request.post("/api/tasks", { data: { title: `חידוד ${tag}`, assigneeId: URI_H, dueDate: d } })).json()).task.id;
  const own = (await (await request.post("/api/tasks", { data: { title: `לעצמי ${tag}`, assigneeId: ADMIN, dueDate: d } })).json()).task.id;
  // whoever gave the task cannot ask for clarification on it
  expect((await request.post(`/api/tasks/${id}/clarify`, { data: { question: "x" } })).status()).toBe(400);
  // a task you gave yourself has nobody to ask
  expect((await request.post(`/api/tasks/${own}/clarify`, { data: {} })).status()).toBe(400);
  const before = await pending(request);
  // the person it belongs to can; the admin has no device or WhatsApp here, so it lands in the digest queue
  await apiLogin(request, URI_H);
  const r = await request.post(`/api/tasks/${id}/clarify`, { data: { question: "איזה לקוח בדיוק?" } });
  expect(r.ok()).toBeTruthy();
  expect((await r.json()).delivered).toBe("none");
  expect((await request.post(`/api/tasks/${id}/clarify`, { data: {} })).status()).toBe(429);
  const detail = await (await request.get(`/api/tasks/${id}`)).json();
  const ev = detail.events.find((e: { type: string }) => e.type === "clarify");
  expect(ev).toBeTruthy();
  expect(ev.note).toBe("צריך חידוד: איזה לקוח בדיוק?");
  expect(ev.actorId).toBe(URI_H);
  await apiLogin(request, ADMIN);
  expect(await pending(request)).toBe(before + 1);
  // a finished task is not clarified
  expect((await request.post(`/api/tasks/${id}/status`, { data: { status: "done", note: "" } })).ok()).toBeTruthy();
  await apiLogin(request, URI_H);
  expect((await request.post(`/api/tasks/${id}/clarify`, { data: {} })).status()).toBe(400);
  await apiLogin(request, ADMIN);
  for (const t of [id, own]) expect((await request.delete(`/api/tasks/${t}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
});

test("answer: whoever gave the task answers an open question – it lands in the details and the person is told", async ({ browser, request }) => {
  await apiLogin(request, ADMIN);
  const d = await today(request);
  const id = (await (await request.post("/api/tasks", { data: { title: `תשובה ${tag}`, assigneeId: URI_H, dueDate: d, details: "לתאם עם הלקוח" } })).json()).task.id;
  // no question yet → nothing to answer
  expect((await request.post(`/api/tasks/${id}/clarify-answer`, { data: { answer: "יובל" } })).status()).toBe(400);
  await apiLogin(request, URI_H);
  expect((await request.post(`/api/tasks/${id}/clarify`, { data: { question: "איזה לקוח?" } })).ok()).toBeTruthy();
  const before = await pending(request);
  // the person the task belongs to cannot answer their own question; someone unrelated cannot either
  expect((await request.post(`/api/tasks/${id}/clarify-answer`, { data: { answer: "x" } })).status()).toBe(400);
  await apiLogin(request, 3);
  expect((await request.post(`/api/tasks/${id}/clarify-answer`, { data: { answer: "x" } })).status()).toBe(403);
  // whoever gave it answers – in the browser
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await uiLogin(page, "דני שקנבסקי");
  await page.getByTestId(`task-${id}`).first().click();
  await expect(page.getByTestId("clarify-answer")).toContainText('אורי חסקל ביקש חידוד: "איזה לקוח?"');
  await page.getByTestId("clarify-answer-text").fill("יובל אוחיון");
  await page.getByTestId("clarify-answer-button").click();
  await expect(page.getByTestId("clarify-answer-button")).toHaveText("נשלח ✓");
  await expect(page.getByText("💬 חידוד מדני ש.: יובל אוחיון")).toBeVisible();
  await ctx.close();
  await apiLogin(request, ADMIN);
  expect((await request.post(`/api/tasks/${id}/clarify-answer`, { data: { answer: "שוב" } })).status()).toBe(400); // already answered
  expect((await request.post(`/api/tasks/${id}/clarify-answer`, { data: { answer: "" } })).status()).toBe(400);
  const detail = await (await request.get(`/api/tasks/${id}`)).json();
  expect(detail.task.details).toBe("לתאם עם הלקוח\n\n💬 חידוד מדני ש.: יובל אוחיון");
  const ev = detail.events.find((e: { type: string }) => e.type === "clarify_answer");
  expect(ev.note).toBe("יובל אוחיון");
  expect(ev.actorId).toBe(ADMIN);
  await apiLogin(request, URI_H);
  expect(await pending(request)).toBe(before + 1);
  await apiLogin(request, ADMIN);
  expect((await request.delete(`/api/tasks/${id}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
});

test("in the browser: the clarify block shows only on a task someone else gave me, and sends", async ({ browser, request }) => {
  await apiLogin(request, 2); // Ron gives the admin a task
  const d = await today(request);
  const id = (await (await request.post("/api/tasks", { data: { title: `חידוד בדפדפן ${tag}`, assigneeId: ADMIN, dueDate: d } })).json()).task.id;
  await apiLogin(request, ADMIN);
  const mine = (await (await request.post("/api/tasks", { data: { title: `שלי בדפדפן ${tag}`, assigneeId: ADMIN, dueDate: d } })).json()).task.id;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await uiLogin(page, "דני שקנבסקי");
  await page.getByTestId(`task-${mine}`).first().click();
  await expect(page.getByTestId("clarify")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByTestId(`task-${id}`).first().click();
  await expect(page.getByTestId("clarify")).toBeVisible();
  await page.getByTestId("clarify-text").fill("איזה חדר?");
  await page.getByTestId("clarify-button").click();
  await expect(page.getByTestId("clarify-button")).toHaveText("נשלח ✓");
  await expect(page.getByText("צריך חידוד: איזה חדר?")).toBeVisible();
  await ctx.close();
  for (const t of [id, mine]) expect((await request.delete(`/api/tasks/${t}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
});

test("make urgent: one tap, only for whoever may edit, and the person it belongs to is told right away", async ({ browser, request }) => {
  await apiLogin(request, ADMIN);
  const d = await today(request);
  const id = (await (await request.post("/api/tasks", { data: { title: `לדחופה ${tag}`, assigneeId: URI_H, dueDate: d } })).json()).task.id;
  await apiLogin(request, URI_H);
  const before = await pending(request);
  // the person it belongs to may not change its importance
  expect((await request.patch(`/api/tasks/${id}`, { data: { priority: "urgent" } })).status()).toBe(403);
  await apiLogin(request, ADMIN);
  const r = await (await request.patch(`/api/tasks/${id}`, { data: { priority: "urgent" } })).json();
  expect(r.task.priority).toBe("urgent");
  // urgent → an immediate message; with no device or WhatsApp here it lands in the digest queue
  await apiLogin(request, URI_H);
  expect(await pending(request)).toBe(before + 1);
  // taking the urgency off does not message again
  await apiLogin(request, ADMIN);
  expect((await (await request.patch(`/api/tasks/${id}`, { data: { priority: "normal" } })).json()).task.priority).toBe("normal");
  await apiLogin(request, URI_H);
  expect(await pending(request)).toBe(before + 1);

  // in the browser: one tap on my own task moves it to the urgent section
  await apiLogin(request, ADMIN);
  const mine = (await (await request.post("/api/tasks", { data: { title: `דחופה בלחיצה ${tag}`, assigneeId: ADMIN, dueDate: d } })).json()).task.id;
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await uiLogin(page, "דני שקנבסקי");
  await expect(page.getByTestId("group-new-1").getByText(`דחופה בלחיצה ${tag}`)).toBeVisible();
  await page.getByTestId(`task-${mine}`).first().click();
  await expect(page.getByTestId("urgent-toggle")).toHaveText("הפוך לדחופה");
  await page.getByTestId("urgent-toggle").click();
  await expect(page.getByTestId("urgent-toggle")).toHaveText("בטל דחיפות");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("group-urgent-1").getByText(`דחופה בלחיצה ${tag}`)).toBeVisible();
  await ctx.close();
  for (const t of [id, mine]) expect((await request.delete(`/api/tasks/${t}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
});

test("done: whoever owns the task marks it done (not only the manager); another employee still cannot", async ({ request }) => {
  await apiLogin(request, 2); // Ron gives Uri Haskal a task (Ron is not Uri H's manager)
  const d = await today(request);
  const id = (await (await request.post("/api/tasks", { data: { title: `סיום ${tag}`, assigneeId: URI_H, dueDate: d } })).json()).task.id;
  await apiLogin(request, URI_H);
  const r = await request.post(`/api/tasks/${id}/status`, { data: { status: "done", note: "" } });
  expect(r.ok()).toBeTruthy();
  expect((await r.json()).task.status).toBe("done");
  // and reopen it themselves
  expect((await request.post(`/api/tasks/${id}/status`, { data: { status: "open", note: "" } })).ok()).toBeTruthy();
  // Uri Shapira (another employee) still cannot touch Uri Haskal's task
  await apiLogin(request, 3);
  expect((await request.post(`/api/tasks/${id}/status`, { data: { status: "done", note: "" } })).status()).toBe(403);
  await apiLogin(request, ADMIN);
  expect((await request.delete(`/api/tasks/${id}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
});

test("recurring: sits on the board until done (no second copy, not 'carried over'), then comes back fresh", async ({ request }) => {
  await apiLogin(request, ADMIN);
  const d = await today(request);
  const rec = await (await request.post("/api/tasks", { data: { title: `קבועה יושבת ${tag}`, assigneeId: URI_H, dueDate: d, weekdays: [0, 1, 2, 3, 4, 5, 6] } })).json();
  const templateId = rec.recurringId;
  type Row = { id: number; recurringId: number | null; dueDate: string; status: string; title: string };
  const board = async () => ((await (await request.get("/api/tasks/board")).json()).tasks as Row[]).filter((t) => t.recurringId === templateId);
  const first = (await board())[0];
  expect(first).toBeTruthy();
  // move today's instance to yesterday and give it a reminder, straight in the local database
  const y = new Date(d + "T00:00:00Z");
  y.setUTCDate(y.getUTCDate() - 1);
  const yesterday = y.toISOString().slice(0, 10);
  execSync(`npx wrangler d1 execute fitness-daily-tasks --local --command "UPDATE tasks SET due_date='${yesterday}', created_date='${yesterday}', reminder_at='2030-01-01T00:00:00.000Z' WHERE id=${first.id}"`, { stdio: "ignore" });
  // a forced re-run does NOT add today's copy while yesterday's is still open; it stays, reminder kept
  expect((await request.patch(`/api/recurring/${templateId}`, { data: { weekdays: [0, 1, 2, 3, 4, 5, 6] } })).ok()).toBeTruthy();
  expect((await board()).map((t) => [t.id, t.dueDate, t.status])).toEqual([[first.id, yesterday, "open"]]);
  expect((await (await request.get(`/api/tasks/${first.id}`)).json()).task.reminderAt).toBe("2030-01-01T00:00:00.000Z");
  // the morning report lists it once, without the "(מ-…)" carry-over mark
  const preview = await (await request.get("/api/settings/morning-report/preview")).json();
  const lines: string[] = preview.people.find((p: { userId: number }) => p.userId === URI_H).lines.filter((l: string) => l.includes(`קבועה יושבת ${tag}`));
  expect(lines).toHaveLength(1);
  expect(lines[0]).not.toContain("(מ-");
  // once it is done, today's fresh copy appears right away
  await apiLogin(request, URI_H);
  expect((await request.post(`/api/tasks/${first.id}/status`, { data: { status: "done", note: "" } })).ok()).toBeTruthy();
  await apiLogin(request, ADMIN);
  const after = await board();
  expect(after.filter((t) => t.status !== "done").map((t) => t.dueDate)).toEqual([d]);
  expect((await request.delete(`/api/recurring/${templateId}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
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
