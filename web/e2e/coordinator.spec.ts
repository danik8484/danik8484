import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

const BASE = process.env.BASE_URL || "http://localhost:8787";
const ADMIN = 1;
const URI_S = 3;
const URI_S_NAME = "אורי שפירא";
const COORD_EMAIL = "guy@example.com";
const COORD_NAME = "גיא וישניה";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

/** Sign in as a team member by id ("pick your name" flow); in development the code is returned instead of sent. */
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

/** The coordinator is created once by the admin and reused across runs (always reset to coordinator under the admin). */
async function ensureCoordinator(admin: APIRequestContext): Promise<number> {
  const { users } = await (await admin.get("/api/users")).json();
  const existing = users.find((u: { name: string }) => u.name === COORD_NAME);
  if (existing) {
    expect((await admin.patch(`/api/users/${existing.id}`, { data: { role: "coordinator", managerId: 1, active: true } })).ok()).toBeTruthy();
    return existing.id;
  }
  // Like any teammate, a coordinator needs a direct manager.
  expect((await admin.post("/api/users", { data: { name: COORD_NAME, role: "coordinator", email: COORD_EMAIL, phone: "052-329-9077" } })).status()).toBe(400);
  const r = await admin.post("/api/users", { data: { name: COORD_NAME, role: "coordinator", email: COORD_EMAIL, phone: "052-329-9077", managerId: 1 } });
  expect(r.status()).toBe(201);
  const { user } = await r.json();
  expect(user.role).toBe("coordinator");
  expect(user.managerId).toBe(1);
  return user.id;
}

/** A disposable teammate created once and reused across runs, reset to the given role/manager and reactivated. */
async function ensureUser(admin: APIRequestContext, name: string, data: { role: string; managerId: number }): Promise<number> {
  const { users } = await (await admin.get("/api/users")).json();
  const existing = users.find((u: { name: string }) => u.name === name);
  if (existing) {
    expect((await admin.patch(`/api/users/${existing.id}`, { data: { ...data, active: true } })).ok()).toBeTruthy();
    return existing.id;
  }
  const r = await admin.post("/api/users", { data: { name, ...data } });
  expect(r.status()).toBe(201);
  return (await r.json()).user.id;
}

async function photoIds(request: APIRequestContext, taskId: number): Promise<number[]> {
  const d = await (await request.get(`/api/tasks/${taskId}`)).json();
  return (d.attachments ?? []).map((a: { id: number }) => a.id);
}

const unique = Date.now().toString().slice(-6);
const has = (list: { id: number }[], id: number) => list.some((t) => t.id === id);
const png = { headers: { "content-type": "image/png", "x-file-name": "proof.png" }, data: PNG };

test.describe.serial("coordinator (רכז): own board like a teammate, sees every board but the admin's, adds tasks to anyone, changes nothing on others' cards", () => {
  let coordId = 0;
  let taskForUriS = 0;
  let adminOwnTask = 0;
  let adminTaskForCoord = 0;
  let coordSelfTask = 0;
  let coordTaskForUriS = 0;
  let coordTaskForAdmin = 0;
  let templateForUriS = 0;
  let uriTaskForCoord = 0;

  test("admin creates the coordinator and can give them tasks like anyone else", async ({ request }) => {
    await apiLogin(request, ADMIN);
    coordId = await ensureCoordinator(request);
    const { today, visibleUserIds } = await (await request.get("/api/me")).json();
    expect(visibleUserIds).toContain(coordId);
    const mk = async (title: string, assigneeId: number) => {
      const r = await request.post("/api/tasks", { data: { title, assigneeId, dueDate: today } });
      expect(r.ok()).toBeTruthy();
      return (await r.json()).task.id as number;
    };
    taskForUriS = await mk(`משימה מדני לאורי ${unique}`, 3);
    adminOwnTask = await mk(`משימה של המנהל לעצמו ${unique}`, 1);
    adminTaskForCoord = await mk(`משימה מדני לרכז ${unique}`, coordId);
    const rec = await request.post("/api/tasks", { data: { title: `קבועה של אורי ${unique}`, assigneeId: 3, dueDate: today, weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    expect(rec.ok()).toBeTruthy();
    templateForUriS = (await rec.json()).recurringId;
  });

  test("the coordinator sees their own board and every other board except the admin's", async ({ request }) => {
    await apiLogin(request, coordId);
    const me = await (await request.get("/api/me")).json();
    expect(me.user.role).toBe("coordinator");
    const expected = me.users
      .filter((u: { id: number; role: string }) => u.id === coordId || (u.role !== "admin" && u.role !== "coordinator"))
      .map((u: { id: number }) => u.id)
      .sort((a: number, b: number) => a - b);
    expect([...me.visibleUserIds].sort((a: number, b: number) => a - b)).toEqual(expected);
    expect(me.visibleUserIds).not.toContain(1);
    const board = await (await request.get(`/api/tasks/board?date=${me.today}`)).json();
    expect(has(board.tasks, taskForUriS)).toBeTruthy();
    expect(has(board.tasks, adminTaskForCoord)).toBeTruthy();
    expect(board.tasks.some((t: { assigneeId: number }) => t.assigneeId === 1)).toBeFalsy();
    expect((await request.get(`/api/tasks/${taskForUriS}`)).ok()).toBeTruthy();
    expect((await request.get(`/api/tasks/${adminTaskForCoord}`)).ok()).toBeTruthy();
    expect((await request.get(`/api/tasks/${adminOwnTask}`)).status()).toBe(403);
  });

  test("on their own card the coordinator works like any teammate: status, photos, own recurring tasks", async ({ request }) => {
    await apiLogin(request, coordId);
    const { today } = await (await request.get("/api/me")).json();
    // a task the admin gave: "in progress" with a note yes, "done" only by the admin / direct manager
    expect((await request.post(`/api/tasks/${adminTaskForCoord}/status`, { data: { status: "in_progress", note: "התחלתי" } })).ok()).toBeTruthy();
    expect((await request.post(`/api/tasks/${adminTaskForCoord}/status`, { data: { status: "done", note: "" } })).status()).toBe(403);
    // a task for themselves: fully theirs
    const self = await request.post("/api/tasks", { data: { title: `משימה של הרכז לעצמו ${unique}`, assigneeId: coordId, dueDate: today } });
    expect(self.ok()).toBeTruthy();
    coordSelfTask = (await self.json()).task.id;
    expect((await request.post(`/api/tasks/${coordSelfTask}/status`, { data: { status: "done", note: "" } })).ok()).toBeTruthy();
    // photos on their own card
    expect((await request.post(`/api/tasks/${adminTaskForCoord}/photos`, png)).ok()).toBeTruthy();
    const ids = await photoIds(request, adminTaskForCoord);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect((await request.delete(`/api/photos/${id}`)).ok()).toBeTruthy();
    // a recurring task for themselves, and the recurring screen is open to them
    const rec = await request.post("/api/tasks", { data: { title: `קבועה של הרכז ${unique}`, assigneeId: coordId, dueDate: today, weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    expect(rec.ok()).toBeTruthy();
    const own = (await rec.json()).recurringId;
    expect((await request.get("/api/recurring")).ok()).toBeTruthy();
    expect((await request.patch(`/api/recurring/${own}`, { data: { title: `קבועה של הרכז (נערכה) ${unique}` } })).ok()).toBeTruthy();
    // today's instance was created on the coordinator's board and can be closed like any recurring task
    const board = await (await request.get(`/api/tasks/board?date=${today}`)).json();
    const instance = board.tasks.find((t: { recurringId: number | null }) => t.recurringId === own);
    expect(instance).toBeTruthy();
    expect((await request.post(`/api/tasks/${instance.id}/status`, { data: { status: "done", note: "" } })).ok()).toBeTruthy();
    expect((await request.delete(`/api/recurring/${own}`, { data: { reason: "סוף הבדיקה" } })).ok()).toBeTruthy();
    // reminders on their own task
    expect((await request.post(`/api/tasks/${adminTaskForCoord}/reminder`, { data: { reminderAt: new Date(Date.now() + 3600_000).toISOString() } })).ok()).toBeTruthy();
    expect((await request.post(`/api/tasks/${adminTaskForCoord}/reminder`, { data: { reminderAt: null } })).ok()).toBeTruthy();
    // upcoming tasks of visible boards are listed too
    const tomorrow = new Date(today + "T00:00:00Z");
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const up = await request.post("/api/tasks", { data: { title: `מחר אצל אורי ${unique}`, assigneeId: 3, dueDate: tomorrow.toISOString().slice(0, 10) } });
    expect(up.ok()).toBeTruthy();
    const upId = (await up.json()).task.id;
    expect(has((await (await request.get(`/api/tasks/board?date=${today}`)).json()).upcoming, upId)).toBeTruthy();
    expect((await request.delete(`/api/tasks/${upId}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
  });

  test("the coordinator adds tasks to anyone (the admin too) but changes nothing on other people's cards", async ({ request }) => {
    await apiLogin(request, coordId);
    const { today } = await (await request.get("/api/me")).json();
    const r1 = await request.post("/api/tasks", { data: { title: `משימה מהרכז לאורי ${unique}`, assigneeId: 3, dueDate: today } });
    expect(r1.ok()).toBeTruthy();
    coordTaskForUriS = (await r1.json()).task.id;
    const r2 = await request.post("/api/tasks", { data: { title: `משימה מהרכז למנהל ${unique}`, assigneeId: 1, dueDate: today } });
    expect(r2.ok()).toBeTruthy();
    coordTaskForAdmin = (await r2.json()).task.id;
    const board = await (await request.get(`/api/tasks/board?date=${today}`)).json();
    expect(has(board.tasks, coordTaskForUriS)).toBeTruthy();
    expect(has(board.sent, coordTaskForAdmin)).toBeTruthy(); // the admin's board is hidden → listed under "sent"
    // recurring tasks for others need managing rights
    expect((await request.post("/api/tasks", { data: { title: "קבועה", assigneeId: 3, dueDate: today, weekdays: [0, 1] } })).status()).toBe(403);
    expect((await request.patch(`/api/recurring/${templateForUriS}`, { data: { title: "שינוי" } })).status()).toBe(403);
    expect((await request.delete(`/api/recurring/${templateForUriS}`, { data: { reason: "בדיקת מחיקה" } })).status()).toBe(403);
    // no status, notes, reminders on others' cards – not even on a task the coordinator added there
    expect((await request.post(`/api/tasks/${taskForUriS}/status`, { data: { status: "done", note: "" } })).status()).toBe(403);
    expect((await request.post(`/api/tasks/${coordTaskForUriS}/status`, { data: { status: "in_progress", note: "בדיקה" } })).status()).toBe(403);
    expect((await request.post(`/api/tasks/${coordTaskForUriS}/reminder`, { data: { reminderAt: new Date(Date.now() + 3600_000).toISOString() } })).status()).toBe(403);
    // photos: not on someone else's task, yes on a task the coordinator added (like any teammate's request)
    expect((await request.post(`/api/tasks/${taskForUriS}/photos`, png)).status()).toBe(403);
    expect((await request.post(`/api/tasks/${coordTaskForUriS}/photos`, png)).ok()).toBeTruthy();
    for (const id of await photoIds(request, coordTaskForUriS)) expect((await request.delete(`/api/photos/${id}`)).ok()).toBeTruthy();
    // edit/delete: only what the coordinator added
    expect((await request.patch(`/api/tasks/${taskForUriS}`, { data: { title: "שינוי" } })).status()).toBe(403);
    expect((await request.delete(`/api/tasks/${taskForUriS}`, { data: { reason: "בדיקת מחיקה" } })).status()).toBe(403);
    expect((await request.patch(`/api/tasks/${coordTaskForUriS}`, { data: { title: `משימה מהרכז לאורי (נערכה) ${unique}` } })).ok()).toBeTruthy();
    expect((await request.delete(`/api/tasks/${coordTaskForAdmin}`, { data: { reason: "הרכז מוחק את שלו" } })).ok()).toBeTruthy();
    // the money and the activity log stay closed
    expect((await request.get("/api/log")).status()).toBe(403);
    expect((await request.get("/api/deals")).status()).toBe(403);
  });

  test("a reminder set by the admin pins the task: the coordinator may still edit it but not move it", async ({ request }) => {
    await apiLogin(request, ADMIN);
    expect((await request.post(`/api/tasks/${coordTaskForUriS}/reminder`, { data: { reminderAt: new Date(Date.now() + 3600_000).toISOString() } })).ok()).toBeTruthy();
    await apiLogin(request, coordId);
    expect((await request.patch(`/api/tasks/${coordTaskForUriS}`, { data: { assigneeId: 5 } })).status()).toBe(403);
    expect((await request.patch(`/api/tasks/${coordTaskForUriS}`, { data: { details: "פירוט חדש" } })).ok()).toBeTruthy();
    const detail = await (await request.get(`/api/tasks/${coordTaskForUriS}`)).json();
    expect(detail.task.assigneeId).toBe(3);
    expect(detail.task.reminderAt).not.toBeNull();
  });

  test("teammates can send the coordinator a request; the admin removes what the coordinator added", async ({ request }) => {
    await apiLogin(request, URI_S);
    const { today } = await (await request.get("/api/me")).json();
    const r = await request.post("/api/tasks", { data: { title: `בקשה מאורי לרכז ${unique}`, assigneeId: coordId, dueDate: today } });
    expect(r.ok()).toBeTruthy();
    uriTaskForCoord = (await r.json()).task.id;
    await apiLogin(request, coordId);
    const board = await (await request.get(`/api/tasks/board?date=${today}`)).json();
    expect(has(board.tasks, uriTaskForCoord)).toBeTruthy();
    expect((await request.post(`/api/tasks/${uriTaskForCoord}/status`, { data: { status: "in_progress", note: "בטיפול" } })).ok()).toBeTruthy();
    await apiLogin(request, ADMIN);
    expect((await request.delete(`/api/tasks/${coordTaskForUriS}`, { data: { reason: "המנהל מסיר" } })).ok()).toBeTruthy();
    expect((await request.delete(`/api/recurring/${templateForUriS}`, { data: { reason: "סוף הבדיקה" } })).ok()).toBeTruthy();
  });

  test("a manager who becomes a coordinator keeps no power over recurring tasks they set for former reports", async ({ request }) => {
    await apiLogin(request, ADMIN);
    const mId = await ensureUser(request, "בדיקה: מנהל-לשעבר", { role: "manager", managerId: 1 });
    const eId = await ensureUser(request, "בדיקה: כפוף למנהל-לשעבר", { role: "employee", managerId: mId });
    const { today } = await (await request.get("/api/me")).json();
    await apiLogin(request, mId);
    const rec = await request.post("/api/tasks", { data: { title: `קבועה מהמנהל הישן ${unique}`, assigneeId: eId, dueDate: today, weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    expect(rec.ok()).toBeTruthy();
    const template = (await rec.json()).recurringId;
    const instance = (await (await request.get(`/api/tasks/board?date=${today}`)).json()).tasks.find((t: { recurringId: number | null }) => t.recurringId === template);
    expect(instance).toBeTruthy();
    expect((await request.post(`/api/tasks/${instance.id}/photos`, png)).ok()).toBeTruthy(); // as a manager: fine
    await apiLogin(request, ADMIN);
    expect((await request.patch(`/api/users/${eId}`, { data: { managerId: 1 } })).ok()).toBeTruthy();
    expect((await request.patch(`/api/users/${mId}`, { data: { role: "coordinator", managerId: 1 } })).ok()).toBeTruthy();
    await apiLogin(request, mId);
    expect((await request.get(`/api/tasks/${instance.id}`)).ok()).toBeTruthy(); // still visible…
    expect((await request.patch(`/api/recurring/${template}`, { data: { title: "שינוי" } })).status()).toBe(403); // …but no longer theirs
    expect((await request.delete(`/api/recurring/${template}`, { data: { reason: "בדיקה" } })).status()).toBe(403);
    expect((await request.patch(`/api/tasks/${instance.id}`, { data: { title: "שינוי" } })).status()).toBe(403);
    expect((await request.delete(`/api/tasks/${instance.id}`, { data: { reason: "בדיקה" } })).status()).toBe(403);
    expect((await request.post(`/api/tasks/${instance.id}/photos`, png)).status()).toBe(403);
    for (const id of await photoIds(request, instance.id)) expect((await request.delete(`/api/photos/${id}`)).status()).toBe(403); // even their own earlier upload
    await apiLogin(request, ADMIN);
    for (const id of await photoIds(request, instance.id)) expect((await request.delete(`/api/photos/${id}`)).ok()).toBeTruthy();
    expect((await request.delete(`/api/recurring/${template}`, { data: { reason: "סוף הבדיקה" } })).ok()).toBeTruthy();
    // leave no card behind: a deactivated teammate keeps a card only while they still have tasks that day
    for (const t of (await (await request.get(`/api/tasks/board?date=${today}`)).json()).tasks.filter((t: { assigneeId: number }) => t.assigneeId === eId || t.assigneeId === mId)) {
      expect((await request.delete(`/api/tasks/${t.id}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
    }
    expect((await request.patch(`/api/users/${mId}`, { data: { role: "employee", managerId: 1, active: false } })).ok()).toBeTruthy();
    expect((await request.patch(`/api/users/${eId}`, { data: { active: false } })).ok()).toBeTruthy();
  });

  test("changing someone's role signs them out, so the app reloads with the new rights", async ({ request, playwright }) => {
    const coord = await playwright.request.newContext({ baseURL: BASE });
    await apiLogin(coord, coordId);
    expect((await coord.get("/api/me")).ok()).toBeTruthy();
    await apiLogin(request, ADMIN);
    expect((await request.patch(`/api/users/${coordId}`, { data: { role: "employee", managerId: 1 } })).ok()).toBeTruthy();
    expect((await coord.get("/api/me")).status()).toBe(401);
    expect((await request.patch(`/api/users/${coordId}`, { data: { role: "coordinator", managerId: 1 } })).ok()).toBeTruthy();
    expect((await (await request.get("/api/users")).json()).users.find((u: { id: number }) => u.id === coordId).role).toBe("coordinator");
    await coord.dispose();
  });

  test("in the browser: own card first, the admin's card hidden, others open; controls only on the own card; teammates see the coordinator blurred", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await uiLogin(page, COORD_NAME);
    await expect(page.getByTestId(`card-${coordId}`)).toBeVisible();
    await expect(page.getByTestId(`card-${coordId}`).locator(".blurred")).toHaveCount(0);
    await expect(page.getByTestId(`card-${coordId}`).getByText("(אני)")).toBeVisible();
    await expect(page.locator('[data-testid^="card-"]').first()).toHaveAttribute("data-testid", `card-${coordId}`);
    await expect(page.getByTestId("card-3")).toBeVisible();
    await expect(page.getByTestId("card-3").locator(".blurred")).toHaveCount(0);
    await expect(page.getByTestId("card-1").locator(".blurred")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "הוספת משימה", exact: true })).toBeVisible();
    // someone else's task: read only
    await page.getByTestId(`task-${taskForUriS}`).first().click();
    await expect(page.getByText(/יכולים לעדכן את הסטטוס/)).toBeVisible();
    await expect(page.getByText("עדכון סטטוס")).toHaveCount(0);
    await expect(page.getByTestId("photos").getByRole("button", { name: /העלאת תמונה/ })).toHaveCount(0);
    await page.goto("/");
    // own task: the usual controls
    await page.getByTestId(`task-${adminTaskForCoord}`).first().click();
    await expect(page.getByText("עדכון סטטוס")).toBeVisible();
    await expect(page.getByTestId("photos").getByRole("button", { name: /העלאת תמונה/ })).toBeVisible();
    await page.goto("/deals");
    await expect(page).toHaveURL(/\/(\?.*)?$/);
    await page.goto("/log");
    await expect(page).toHaveURL(/\/(\?.*)?$/);
    await page.goto("/recurring");
    await expect(page).toHaveURL(/\/recurring$/);
    await ctx.close();

    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await uiLogin(page2, URI_S_NAME);
    await expect(page2.getByTestId("card-3")).toBeVisible();
    await expect(page2.getByTestId(`card-${coordId}`).locator(".blurred")).toHaveCount(1);
    await expect(page2.getByTestId(`card-${coordId}`).getByRole("button", { name: /בקשת משימה/ })).toBeVisible();
    await ctx2.close();
  });

  test("cleanup: the coordinator is deactivated so the other specs see the seeded team of five", async ({ request }) => {
    await apiLogin(request, ADMIN);
    expect((await request.patch(`/api/users/${coordId}`, { data: { active: false } })).ok()).toBeTruthy();
    const { team } = await (await request.get("/api/auth/config")).json();
    expect(team.some((u: { id: number }) => u.id === coordId)).toBeFalsy();
  });
});
