import { test, expect, type Browser, type Page, type APIRequestContext } from "@playwright/test";

const NAME: Record<string, string> = { "dani@example.com": "דני שקנבסקי", "uri.h@example.com": "אורי חסקל" };

async function login(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByTestId("team-picker").getByRole("button", { name: NAME[email], exact: true }).click();
  await page.getByRole("button", { name: "שלח לי קוד לוואטסאפ" }).click();
  await expect(page.getByTestId("dev-code").or(page.locator(".bg-red-50"))).toBeVisible();
  const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
  await page.getByLabel("קוד אימות").fill(code);
  await page.getByRole("button", { name: "כניסה" }).click();
  await expect(page.getByTestId("card-1")).toBeVisible();
  return page;
}
async function apiLogin(request: APIRequestContext, email: string) {
  const r = await request.post("/api/auth/request-code", { data: { email } });
  const { devCode } = await r.json();
  expect((await request.post("/api/auth/verify", { data: { email, code: devCode } })).ok()).toBeTruthy();
}

const tag = Date.now().toString().slice(-6);

test("urgent tasks sit on top in bold with a siren; high priority precedes normal", async ({ browser, request }) => {
  await apiLogin(request, "dani@example.com");
  const { today } = await (await request.get("/api/me")).json();
  const mk = async (title: string, priority: string) => (await (await request.post("/api/tasks", { data: { title, assigneeId: 5, dueDate: today, priority } })).json()).task.id;
  const normal = await mk(`רגילה ${tag}`, "normal");
  const high = await mk(`גבוהה ${tag}`, "high");
  const urgent = await mk(`דחופה ${tag}`, "urgent");
  expect((await request.post("/api/tasks", { data: { title: "x", assigneeId: 5, dueDate: today, priority: "mega" } })).status()).toBe(400);
  // Recurring templates cannot carry a priority
  const rec = await (await request.get("/api/recurring")).json();
  const daily = rec.recurring.find((r: { assigneeId: number; kind: string }) => r.assigneeId === 5 && r.kind === "normal");
  if (daily) {
    const board = await (await request.get("/api/tasks/board")).json();
    const inst = board.tasks.find((t: { recurringId: number | null; assigneeId: number }) => t.recurringId === daily.id);
    if (inst) expect((await request.patch(`/api/tasks/${inst.id}`, { data: { priority: "urgent" } })).status()).toBe(400);
  }

  const page = await login(browser, "dani@example.com");
  const card = page.getByTestId("card-5");
  await expect(page.getByTestId("group-urgent-5").getByText(`דחופה ${tag}`)).toBeVisible();
  const urgentBox = (await page.getByTestId(`task-${urgent}`).boundingBox())!;
  const highBox = (await page.getByTestId(`task-${high}`).boundingBox())!;
  const normalBox = (await page.getByTestId(`task-${normal}`).boundingBox())!;
  expect(urgentBox.y).toBeLessThan(highBox.y);
  expect(highBox.y).toBeLessThan(normalBox.y);
  await expect(page.getByTestId(`task-${urgent}`).getByLabel("דחוף")).toBeVisible();
  const weight = await page.getByTestId(`task-${urgent}`).locator("span.font-black").count();
  expect(weight).toBeGreaterThan(0);
  void card;

  // Edit priority through the form
  await page.getByTestId(`task-${normal}`).click();
  await page.getByRole("dialog").getByRole("button", { name: "עריכה" }).click();
  await page.getByTestId("priority").getByRole("radio", { name: /עדיפות גבוהה/ }).click();
  await page.getByRole("button", { name: "שמירת שינויים" }).click();
  await expect(page.getByRole("dialog").getByText("⬆️ עדיפות גבוהה").first()).toBeVisible();
  await page.context().close();
});

test("anyone can send an immediate full-detail notice; unreachable recipients fall back to the digest", async ({ browser, request }) => {
  await apiLogin(request, "uri.h@example.com");
  const before = (await (await request.get("/api/push/pending")).json()).pending;
  await request.post("/api/auth/logout");

  const page = await login(browser, "dani@example.com");
  await page.getByTestId("card-5").getByRole("button", { name: /הוספת משימה/ }).click();
  await page.getByLabel("משימה", { exact: true }).fill(`מיידית ${tag}`);
  await page.getByTestId("priority").getByRole("radio", { name: /דחוף/ }).click();
  await expect(page.getByTestId("notify-now")).toBeChecked(); // urgent pre-selects immediate notice for managers
  await page.getByRole("button", { name: "הוספה" }).click();
  await expect(page.getByTestId("card-5").getByText(`מיידית ${tag}`)).toBeVisible();
  await page.context().close();

  await apiLogin(request, "uri.h@example.com");
  const after = (await (await request.get("/api/push/pending")).json()).pending;
  // In this test environment Uri has no reachable device or WhatsApp, so the immediate notice
  // falls back to the digest queue instead of being lost (exactly one entry for this task).
  expect(after).toBe(before + 1);
  await request.post("/api/auth/logout");

  // Employees may send it too (6.9): an immediate notice to the admin, who falls back to the digest here
  await apiLogin(request, "uri.h@example.com");
  const r = await request.post("/api/tasks", { data: { title: `מ-אורי ${tag}`, assigneeId: 1, dueDate: "2030-01-01", notifyNow: true } });
  expect(r.status()).toBe(201);
  await request.post("/api/auth/logout");
  await apiLogin(request, "dani@example.com");
  expect((await (await request.get("/api/push/pending")).json()).pending).toBeGreaterThanOrEqual(1);
});

test("task reminders fire at the chosen time, repeat every 30 minutes, and stop on done", async ({ request }) => {
  await apiLogin(request, "dani@example.com");
  const { today } = await (await request.get("/api/me")).json();
  const created = await (await request.post("/api/tasks", { data: { title: `עם תזכורת ${tag}`, assigneeId: 5, dueDate: today } })).json();
  const id = created.task.id;
  expect((await request.post(`/api/tasks/${id}/reminder`, { data: { reminderAt: "not-a-date" } })).status()).toBe(400);
  expect((await request.post(`/api/tasks/${id}/reminder`, { data: { reminderAt: "2020-01-01T10:00:00Z" } })).status()).toBe(400); // in the past
  const soon = new Date(Date.now() - 60 * 1000).toISOString(); // within the 5-minute grace: due now
  const set = await (await request.post(`/api/tasks/${id}/reminder`, { data: { reminderAt: soon } })).json();
  expect(set.task.reminderAt).toBe(soon);
  expect(set.task.reminderLastSentAt).toBeNull();

  expect((await request.get("/__scheduled?cron=*/5+*+*+*+*")).ok()).toBeTruthy();
  const afterFirst = await (await request.get(`/api/tasks/${id}`)).json();
  expect(afterFirst.task.reminderLastSentAt).not.toBeNull();
  expect(afterFirst.events.some((e: { type: string }) => e.type === "reminder")).toBeTruthy();

  // Runs again right away: no second send (30-minute spacing)
  expect((await request.get("/__scheduled?cron=*/5+*+*+*+*")).ok()).toBeTruthy();
  const afterSecond = await (await request.get(`/api/tasks/${id}`)).json();
  expect(afterSecond.task.reminderLastSentAt).toBe(afterFirst.task.reminderLastSentAt);

  // Done clears the reminder
  expect((await request.post(`/api/tasks/${id}/status`, { data: { status: "done", note: "" } })).ok()).toBeTruthy();
  const done = await (await request.get(`/api/tasks/${id}`)).json();
  expect(done.task.reminderAt).toBeNull();
  expect((await request.post(`/api/tasks/${id}/reminder`, { data: { reminderAt: new Date(Date.now() + 3600e3).toISOString() } })).status()).toBe(400);

  // Only people who manage the card may set reminders
  await request.post("/api/auth/logout");
  await apiLogin(request, "uri.s@example.com");
  expect((await request.post(`/api/tasks/${id}/reminder`, { data: { reminderAt: new Date(Date.now() + 3600e3).toISOString() } })).status()).toBe(403);
});

test("settings are admin-only, validated, and daily reminder times default to 21:00 / Fri 14:00 / Sat 19:00", async ({ request }) => {
  await apiLogin(request, "uri.h@example.com");
  expect((await request.get("/api/settings")).status()).toBe(403);
  await request.post("/api/auth/logout");

  await apiLogin(request, "dani@example.com");
  const s = await (await request.get("/api/settings")).json();
  expect(s.reminderTimes).toEqual(["21:00", "21:00", "21:00", "21:00", "21:00", "14:00", "19:00"]);
  expect(s.telegramConfigured).toBe(false);
  expect((await request.put("/api/settings", { data: { reminderTimes: ["25:00", "", "", "", "", "", ""] } })).status()).toBe(400);
  expect((await request.put("/api/settings", { data: { telegramBotToken: "bad-token" } })).status()).toBe(400);
  expect((await request.put("/api/settings", { data: { telegramChatId: "abc" } })).status()).toBe(400);
  expect((await request.put("/api/settings", { data: { reminderTimes: ["20:30", "21:00", "21:00", "21:00", "21:00", "", "19:00"], telegramChatId: "12345" } })).status()).toBe(200);
  const s2 = await (await request.get("/api/settings")).json();
  expect(s2.reminderTimes[0]).toBe("20:30");
  expect(s2.reminderTimes[5]).toBe("");
  expect(s2.telegramChatId).toBe("12345");
  // Secrets are masked and kept when left empty
  expect((await request.put("/api/settings", { data: { telegramBotToken: "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcd" } })).status()).toBe(200);
  const s3 = await (await request.get("/api/settings")).json();
  expect(s3.telegramBotToken).toMatch(/^1234••••/);
  expect(s3.telegramConfigured).toBe(true);
  expect((await request.put("/api/settings", { data: { telegramBotToken: "" } })).status()).toBe(200);
  expect((await (await request.get("/api/settings")).json()).telegramConfigured).toBe(true);
  // Feed to an unreachable Telegram must not break task operations
  const { today } = await (await request.get("/api/me")).json();
  expect((await request.post("/api/tasks", { data: { title: `עם טלגרם ${tag}`, assigneeId: 5, dueDate: today } })).status()).toBe(201);
  // Clear
  expect((await request.put("/api/settings", { data: { telegramBotToken: "-", telegramChatId: "" } })).status()).toBe(200);
  expect((await (await request.get("/api/settings")).json()).telegramConfigured).toBe(false);
  // WhatsApp through the company's Baileys bridge (Green API format)
  expect((await request.put("/api/settings", { data: { whatsappMode: "bridge", bridgeHost: "http://insecure.example", bridgeInstanceId: "1", bridgeToken: "x" } })).status()).toBe(400);
  expect((await request.put("/api/settings", { data: { whatsappMode: "bridge", bridgeHost: "https://wa-bridge.up.railway.app/", bridgeInstanceId: "7107645253", bridgeToken: "bridge-secret-token-1" } })).status()).toBe(200);
  const s4 = await (await request.get("/api/settings")).json();
  expect(s4.whatsappMode).toBe("bridge");
  expect(s4.bridgeHost).toBe("https://wa-bridge.up.railway.app");
  expect(s4.bridgeConfigured).toBe(true);
  expect(s4.whatsappConfigured).toBe(true);
  expect(s4.bridgeToken).toMatch(/^brid••••/);
  // In development the login code is shown on screen and nothing is sent to the bridge
  const rc = await request.post("/api/auth/request-code", { data: { userId: 5 } });
  expect(rc.status()).toBe(200);
  expect((await rc.json()).devCode).toMatch(/^\d{6}$/);
  expect((await request.put("/api/settings", { data: { bridgeToken: "-", bridgeHost: "", bridgeInstanceId: "" } })).status()).toBe(200);
  expect((await (await request.get("/api/settings")).json()).whatsappConfigured).toBe(false);
  await request.post("/api/settings/reset-reminders");
  expect((await (await request.get("/api/settings")).json()).reminderTimes[0]).toBe("21:00");
  // Forced cron in dev sends the day-end reminder path without crashing
  expect((await request.get("/__scheduled?cron=force")).ok()).toBeTruthy();
});

test("login: pick a name, get a code, wrong person's code is refused", async ({ request }) => {
  const cfg = await (await request.get("/api/auth/config")).json();
  expect(cfg.team.map((u: { name: string }) => u.name)).toEqual(expect.arrayContaining(["דני שקנבסקי", "רון וליצ'קו", "אורי שפירא", "דני קגנוביץ", "אורי חסקל"]));
  const r = await request.post("/api/auth/request-code", { data: { userId: 3 } });
  expect(r.status()).toBe(200);
  const { devCode } = await r.json();
  expect((await request.post("/api/auth/verify", { data: { userId: 2, code: devCode } })).status()).toBe(401);
  expect((await request.post("/api/auth/verify", { data: { userId: 3, code: devCode } })).status()).toBe(200);
  const me = await (await request.get("/api/me")).json();
  expect(me.user.name).toBe("אורי שפירא");
  expect((await request.post("/api/auth/request-code", { data: { userId: 999 } })).status()).toBe(404);
});
