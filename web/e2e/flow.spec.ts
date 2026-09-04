import { test, expect, type Browser, type Page, type APIRequestContext } from "@playwright/test";

const EMAILS = {
  dani: "dani@example.com",
  ron: "ron@example.com",
  uriS: "uri.s@example.com",
  daniK: "dani.k@example.com",
  uriH: "uri.h@example.com",
};

async function login(browser: Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByLabel("כתובת מייל").fill(email);
  await page.getByRole("button", { name: "שלח לי קוד" }).click();
  const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
  await page.getByLabel("קוד כניסה").fill(code);
  await page.getByRole("button", { name: "כניסה" }).click();
  await expect(page.getByRole("heading", { name: "לו\"ז יומי" }).or(page.getByText("לו\"ז יומי").first())).toBeVisible();
  await expect(page.getByTestId("card-1")).toBeVisible();
  return page;
}

async function apiLogin(request: APIRequestContext, email: string) {
  const r = await request.post("/api/auth/request-code", { data: { email } });
  const { devCode } = await r.json();
  const v = await request.post("/api/auth/verify", { data: { email, code: devCode } });
  expect(v.ok()).toBeTruthy();
}

const unique = Date.now().toString().slice(-6);
const T = {
  daniForUriS: `משימה מדני לאורי שפירא ${unique}`,
  daniSelf: `משימה של דני לעצמו ${unique}`,
  uriSSelf: `משימה של אורי שפירא לעצמו ${unique}`,
  recurring: `ניקיון חדר כושר ${unique}`,
};

test.describe.serial("daily schedule flow", () => {
  test("admin sees everyone and assigns tasks", async ({ browser }) => {
    const page = await login(browser, EMAILS.dani);
    for (const id of [1, 2, 3, 4, 5]) {
      await expect(page.getByTestId(`card-${id}`)).toBeVisible();
      await expect(page.getByTestId(`card-${id}`).locator(".blurred")).toHaveCount(0);
    }

    // Task for Uri Shapira
    await page.getByTestId("card-3").getByRole("button", { name: /הוספת משימה/ }).click();
    await page.getByLabel("משימה", { exact: true }).fill(T.daniForUriS);
    await page.getByLabel("פירוט (לא חובה)").fill("לחזור לכל הלידים מאתמול");
    await expect(page.getByLabel("עובד")).toHaveValue("3");
    await page.getByRole("button", { name: "הוספה" }).click();
    await expect(page.getByTestId("card-3").getByText(T.daniForUriS)).toBeVisible();
    await expect(page.getByTestId("card-3").getByText("מאת דני שקנבסקי").first()).toBeVisible();

    // Task for self via the floating button
    await page.getByRole("button", { name: "הוספת משימה", exact: true }).click();
    await page.getByLabel("משימה", { exact: true }).fill(T.daniSelf);
    await page.getByRole("button", { name: "הוספה" }).click();
    await expect(page.getByTestId("card-1").getByText(T.daniSelf)).toBeVisible();

    // Recurring daily task for Uri Haskel
    await page.getByTestId("card-5").getByRole("button", { name: /הוספת משימה/ }).click();
    await page.getByLabel("משימה", { exact: true }).fill(T.recurring);
    await page.getByLabel(/משימה קבועה/).check();
    for (const d of ["ו׳", "ש׳"]) await page.getByRole("button", { name: d, exact: true }).click(); // select all 7 days
    await page.getByRole("button", { name: "הוספה" }).click();
    await expect(page.getByTestId("card-5").getByText(T.recurring)).toBeVisible();
    await expect(page.getByTestId("card-5").getByText("קבועה").first()).toBeVisible();
    await page.context().close();
  });

  test("manager sees only self + direct report, others blurred", async ({ browser, request }) => {
    const page = await login(browser, EMAILS.ron);
    await expect(page.getByTestId("card-2").locator(".blurred")).toHaveCount(0);
    await expect(page.getByTestId("card-3").locator(".blurred")).toHaveCount(0);
    await expect(page.getByTestId("card-1").locator(".blurred")).toHaveCount(1);
    await expect(page.getByTestId("card-4").locator(".blurred")).toHaveCount(1);
    await expect(page.getByTestId("card-5").locator(".blurred")).toHaveCount(1);
    await expect(page.getByTestId("card-1").getByText(T.daniSelf)).toHaveCount(0);
    // Ron sees the task Dani gave to Uri Shapira
    await expect(page.getByTestId("card-3").getByText(T.daniForUriS)).toBeVisible();

    // In-progress requires a note
    await page.getByTestId("card-3").getByText(T.daniForUriS).click();
    await page.getByRole("radio", { name: "בתהליך" }).click();
    await expect(page.getByRole("button", { name: "שמירת עדכון" })).toBeDisabled();
    await page.getByLabel(/מה בוצע ומה נשאר/).fill("חזרתי ל-3 לידים, נשארו 2");
    await page.getByRole("button", { name: "שמירת עדכון" }).click();
    await expect(page.getByRole("dialog").getByText("פתוח ← בתהליך")).toBeVisible();
    // Ron cannot delete Dani's task (not creator, not admin)
    await expect(page.getByRole("dialog").getByRole("button", { name: "מחיקה" })).toHaveCount(0);
    await page.getByRole("button", { name: "סגירה" }).click();
    await expect(page.getByTestId("card-3").getByText("חזרתי ל-3 לידים, נשארו 2")).toBeVisible();

    // API: Ron may not add a task for Uri Haskel (not his report)
    await apiLogin(request, EMAILS.ron);
    const forbidden = await request.post("/api/tasks", { data: { title: "x", assigneeId: 5, dueDate: "2030-01-01" } });
    expect(forbidden.status()).toBe(403);
    const forbiddenRead = await request.get("/api/tasks/board");
    const board = await forbiddenRead.json();
    expect(board.tasks.every((t: { assigneeId: number }) => [2, 3].includes(t.assigneeId))).toBeTruthy();
    const log = await request.get("/api/log");
    expect(log.status()).toBe(200);
    await page.context().close();
  });

  test("employee sees only own card, self-manages, deletes with reason", async ({ browser, request }) => {
    const page = await login(browser, EMAILS.uriS);
    await expect(page.getByTestId("card-3").locator(".blurred")).toHaveCount(0);
    for (const id of [1, 2, 4, 5]) await expect(page.getByTestId(`card-${id}`).locator(".blurred")).toHaveCount(1);
    await expect(page.getByRole("link", { name: "יומן פעילות" })).toHaveCount(0);

    await page.getByRole("button", { name: "הוספת משימה", exact: true }).click();
    await expect(page.getByLabel("עובד").locator("option")).toHaveCount(1);
    await page.getByLabel("משימה", { exact: true }).fill(T.uriSSelf);
    await page.getByRole("button", { name: "הוספה" }).click();
    await expect(page.getByTestId("card-3").getByText(T.uriSSelf)).toBeVisible();

    // Complete the manager's task
    await page.getByTestId("card-3").getByText(T.daniForUriS).click();
    await page.getByRole("radio", { name: "הושלם" }).click();
    await page.getByRole("button", { name: "שמירת עדכון" }).click();
    await expect(page.getByRole("dialog").getByText("בתהליך ← הושלם")).toBeVisible();
    await page.getByRole("button", { name: "סגירה" }).click();

    // Delete own task – reason required
    await page.getByTestId("card-3").getByText(T.uriSSelf).click();
    await page.getByRole("dialog").getByRole("button", { name: "מחיקה" }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "מחיקה" })).toBeDisabled();
    await page.getByLabel("סיבת המחיקה (חובה)").fill("נוספה בטעות פעמיים");
    await page.getByRole("dialog").getByRole("button", { name: "מחיקה" }).click();
    await expect(page.getByTestId("card-3").getByText(T.uriSSelf)).toHaveCount(0);

    // API: employee cannot read the log or users
    await apiLogin(request, EMAILS.uriS);
    expect((await request.get("/api/log")).status()).toBe(403);
    expect((await request.get("/api/users")).status()).toBe(403);
    await page.context().close();
  });

  test("admin reviews the day and the activity log", async ({ browser }) => {
    const page = await login(browser, EMAILS.dani);
    // Completed task shows under Uri Shapira with the ✓ counter
    await expect(page.getByTestId("card-3").getByText(T.daniForUriS)).toBeVisible();
    await expect(page.getByTestId("card-3").getByTitle("הושלמו")).toContainText(/[1-9]/);

    await page.getByRole("button", { name: "תפריט" }).click();
    await page.getByRole("link", { name: "יומן פעילות" }).click();
    await expect(page.getByText("נוספה בטעות פעמיים").first()).toBeVisible();
    await expect(page.getByText("חזרתי ל-3 לידים, נשארו 2").first()).toBeVisible();
    // Open the deleted task from the log and see the deletion banner
    await page.getByText(T.uriSSelf).first().click();
    await expect(page.getByRole("dialog").getByText("המשימה נמחקה")).toBeVisible();
    await page.getByRole("button", { name: "סגירה" }).click();

    // Recurring page lists the recurring task
    await page.getByRole("button", { name: "תפריט" }).click();
    await page.getByRole("link", { name: "משימות קבועות" }).click();
    await expect(page.getByText(T.recurring)).toBeVisible();
    await expect(page.getByText("כל יום").first()).toBeVisible();
    await page.context().close();
  });
});
