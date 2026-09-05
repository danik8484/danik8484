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

/** The coordinator is created once by the admin and reused across runs. */
async function ensureCoordinator(admin: APIRequestContext): Promise<number> {
  const { users } = await (await admin.get("/api/users")).json();
  const existing = users.find((u: { name: string }) => u.name === COORD_NAME);
  if (existing) return existing.id;
  // managerId is sent on purpose: a coordinator reports to nobody, so the server must drop it.
  const r = await admin.post("/api/users", { data: { name: COORD_NAME, role: "coordinator", email: COORD_EMAIL, phone: "052-329-9077", managerId: 2 } });
  expect(r.status()).toBe(201);
  const { user } = await r.json();
  expect(user.role).toBe("coordinator");
  expect(user.managerId).toBeNull();
  return user.id;
}

const unique = Date.now().toString().slice(-6);
const has = (list: { id: number }[], id: number) => list.some((t) => t.id === id);

test.describe.serial("coordinator (רכז): sees every board but the admin's, adds tasks to anyone, changes nothing else", () => {
  let coordId = 0;
  let taskForUriS = 0;
  let adminOwnTask = 0;
  let coordTaskForUriS = 0;
  let coordTaskForAdmin = 0;
  let templateId = 0;

  test("admin creates the coordinator; nobody can assign a task to a coordinator", async ({ request }) => {
    await apiLogin(request, ADMIN);
    coordId = await ensureCoordinator(request);
    const { today, visibleUserIds } = await (await request.get("/api/me")).json();
    expect(visibleUserIds).toContain(coordId); // the admin's rights cover everyone; the board simply has no card for a coordinator
    const mk = async (title: string, assigneeId: number) => {
      const r = await request.post("/api/tasks", { data: { title, assigneeId, dueDate: today } });
      expect(r.ok()).toBeTruthy();
      return (await r.json()).task.id as number;
    };
    taskForUriS = await mk(`משימה מדני לאורי ${unique}`, 3);
    adminOwnTask = await mk(`משימה של המנהל לעצמו ${unique}`, 1);
    expect((await request.post("/api/tasks", { data: { title: "לרכז", assigneeId: coordId, dueDate: today } })).status()).toBe(400);
    // a recurring template for Uri Shapira, to prove the coordinator cannot touch it later
    const rec = await request.post("/api/tasks", { data: { title: `קבועה של אורי ${unique}`, assigneeId: 3, dueDate: today, weekdays: [0, 1, 2, 3, 4, 5, 6] } });
    expect(rec.ok()).toBeTruthy();
    templateId = (await rec.json()).recurringId;
  });

  test("the coordinator sees all boards except the admin's, and opens only those tasks", async ({ request }) => {
    await apiLogin(request, coordId);
    const me = await (await request.get("/api/me")).json();
    expect(me.user.role).toBe("coordinator");
    const expected = me.users
      .filter((u: { role: string }) => u.role !== "admin" && u.role !== "coordinator")
      .map((u: { id: number }) => u.id)
      .sort((a: number, b: number) => a - b);
    expect([...me.visibleUserIds].sort((a: number, b: number) => a - b)).toEqual(expected);
    expect(me.visibleUserIds).not.toContain(1);
    expect(me.visibleUserIds).not.toContain(coordId);
    const board = await (await request.get(`/api/tasks/board?date=${me.today}`)).json();
    expect(has(board.tasks, taskForUriS)).toBeTruthy();
    expect(board.tasks.some((t: { assigneeId: number }) => t.assigneeId === 1)).toBeFalsy();
    expect((await request.get(`/api/tasks/${taskForUriS}`)).ok()).toBeTruthy();
    expect((await request.get(`/api/tasks/${adminOwnTask}`)).status()).toBe(403);
  });

  test("the coordinator adds tasks to anyone (the admin too) but cannot change status, photos, reminders, recurring tasks or others' tasks", async ({ request }) => {
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
    // not to themselves: a coordinator has no board
    expect((await request.post("/api/tasks", { data: { title: "לעצמי", assigneeId: coordId, dueDate: today } })).status()).toBe(400);
    // recurring tasks need managing rights, which a coordinator never has
    expect((await request.post("/api/tasks", { data: { title: "קבועה", assigneeId: 3, dueDate: today, weekdays: [0, 1] } })).status()).toBe(403);
    expect((await request.patch(`/api/recurring/${templateId}`, { data: { title: "שינוי" } })).status()).toBe(403);
    expect((await request.delete(`/api/recurring/${templateId}`, { data: { reason: "בדיקת מחיקה" } })).status()).toBe(403);
    // no status or note changes – not even on a task the coordinator added
    expect((await request.post(`/api/tasks/${taskForUriS}/status`, { data: { status: "done", note: "" } })).status()).toBe(403);
    expect((await request.post(`/api/tasks/${coordTaskForUriS}/status`, { data: { status: "in_progress", note: "בדיקה" } })).status()).toBe(403);
    // no photos, no reminders
    expect((await request.post(`/api/tasks/${taskForUriS}/photos`, { headers: { "content-type": "image/png", "x-file-name": "proof.png" }, data: PNG })).status()).toBe(403);
    expect((await request.post(`/api/tasks/${coordTaskForUriS}/photos`, { headers: { "content-type": "image/png", "x-file-name": "proof.png" }, data: PNG })).status()).toBe(403);
    expect((await request.post(`/api/tasks/${coordTaskForUriS}/reminder`, { data: { reminderAt: new Date(Date.now() + 3600_000).toISOString() } })).status()).toBe(403);
    // edit/delete: only the coordinator's own tasks
    expect((await request.patch(`/api/tasks/${taskForUriS}`, { data: { title: "שינוי" } })).status()).toBe(403);
    expect((await request.delete(`/api/tasks/${taskForUriS}`, { data: { reason: "בדיקת מחיקה" } })).status()).toBe(403);
    expect((await request.patch(`/api/tasks/${coordTaskForUriS}`, { data: { title: `משימה מהרכז לאורי (נערכה) ${unique}` } })).ok()).toBeTruthy();
    expect((await request.delete(`/api/tasks/${coordTaskForAdmin}`, { data: { reason: "הרכז מוחק את שלו" } })).ok()).toBeTruthy();
    // the other screens are closed to a coordinator
    expect((await request.get("/api/log")).status()).toBe(403);
    expect((await request.get("/api/deals")).status()).toBe(403);
    expect((await request.get("/api/recurring")).status()).toBe(403);
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

  test("a teammate cannot assign to the coordinator; the admin removes the coordinator's task; tasks of any status block the role change", async ({ request }) => {
    await apiLogin(request, URI_S);
    const { today } = await (await request.get("/api/me")).json();
    expect((await request.post("/api/tasks", { data: { title: "לרכז", assigneeId: coordId, dueDate: today } })).status()).toBe(400);
    await apiLogin(request, ADMIN);
    expect((await request.delete(`/api/tasks/${coordTaskForUriS}`, { data: { reason: "המנהל מסיר" } })).ok()).toBeTruthy();
    expect((await request.delete(`/api/recurring/${templateId}`, { data: { reason: "סוף הבדיקה" } })).ok()).toBeTruthy();
    // Uri Shapira has tasks → cannot become a coordinator
    const r = await request.patch("/api/users/3", { data: { role: "coordinator" } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error).toContain("לא ניתן להפוך לרכז");
  });

  test("even a single finished task blocks the conversion; a person with nothing assigned converts fine", async ({ request }) => {
    await apiLogin(request, ADMIN);
    const { today } = await (await request.get("/api/me")).json();
    // a disposable teammate whose only task is a finished one (reused across runs)
    const { users } = await (await request.get("/api/users")).json();
    let tmp = users.find((u: { name: string }) => u.name === "בדיקת המרה לרכז");
    if (!tmp) tmp = (await (await request.post("/api/users", { data: { name: "בדיקת המרה לרכז", role: "employee", managerId: 1 } })).json()).user;
    expect((await request.patch(`/api/users/${tmp.id}`, { data: { role: "employee", managerId: 1, active: true } })).ok()).toBeTruthy();
    const done = (await (await request.post("/api/tasks", { data: { title: `הושלמה ${unique}`, assigneeId: tmp.id, dueDate: today } })).json()).task.id;
    expect((await request.post(`/api/tasks/${done}/status`, { data: { status: "done", note: "" } })).ok()).toBeTruthy();
    const blocked = await request.patch(`/api/users/${tmp.id}`, { data: { role: "coordinator" } });
    expect(blocked.status()).toBe(400);
    expect((await blocked.json()).error).toContain("כולל שהושלמו");
    // once nothing points at them, the conversion goes through, and back again for the next run
    expect((await request.delete(`/api/tasks/${done}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
    const ok = await request.patch(`/api/users/${tmp.id}`, { data: { role: "coordinator" } });
    expect(ok.ok()).toBeTruthy();
    expect((await ok.json()).user.role).toBe("coordinator");
    expect((await request.patch(`/api/users/${tmp.id}`, { data: { role: "employee", managerId: 1, active: false } })).ok()).toBeTruthy();
  });

  test("changing someone's role signs them out, so the app reloads with the new rights", async ({ request, playwright }) => {
    const coord = await playwright.request.newContext({ baseURL: BASE });
    await apiLogin(coord, coordId);
    expect((await coord.get("/api/me")).ok()).toBeTruthy();
    await apiLogin(request, ADMIN);
    expect((await request.patch(`/api/users/${coordId}`, { data: { role: "employee", managerId: 1 } })).ok()).toBeTruthy();
    expect((await coord.get("/api/me")).status()).toBe(401);
    expect((await request.patch(`/api/users/${coordId}`, { data: { role: "coordinator" } })).ok()).toBeTruthy();
    expect((await (await request.get("/api/users")).json()).users.find((u: { id: number }) => u.id === coordId).role).toBe("coordinator");
    await coord.dispose();
  });

  test("in the browser: no own card, the admin's card stays hidden, add buttons present, no status/photo/recurring controls; teammates see no coordinator card", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await uiLogin(page, COORD_NAME);
    await expect(page.getByTestId("card-3")).toBeVisible();
    await expect(page.getByTestId("card-3").locator(".blurred")).toHaveCount(0);
    await expect(page.getByTestId(`card-${coordId}`)).toHaveCount(0);
    await expect(page.getByTestId("card-1").locator(".blurred")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "הוספת משימה", exact: true })).toBeVisible();
    // the add form offers no recurring task
    await page.getByTestId("card-3").getByRole("button", { name: /הוספת משימה/ }).click();
    await expect(page.getByLabel("איש צוות")).toHaveValue("3");
    await expect(page.getByLabel(/משימה קבועה/)).toBeDisabled();
    await page.getByRole("button", { name: "ביטול" }).click();
    for (const path of ["/deals", "/log", "/recurring"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/(\?.*)?$/);
      await expect(page.getByTestId("card-3")).toBeVisible();
    }
    await page.getByTestId(`task-${taskForUriS}`).first().click();
    await expect(page.getByText(/יכולים לעדכן את הסטטוס/)).toBeVisible();
    await expect(page.getByText("עדכון סטטוס")).toHaveCount(0);
    await expect(page.getByTestId("photos").getByRole("button", { name: /העלאת תמונה/ })).toHaveCount(0);
    await ctx.close();

    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await uiLogin(page2, URI_S_NAME);
    await expect(page2.getByTestId("card-3")).toBeVisible();
    await expect(page2.getByTestId(`card-${coordId}`)).toHaveCount(0);
    await ctx2.close();
  });
});
