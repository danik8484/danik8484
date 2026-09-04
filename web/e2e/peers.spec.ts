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

const tag = Date.now().toString().slice(-6);
const T = {
  uriToDani: `בקשה מאורי חסקל לדני ${tag}`,
  daniToUri: `הוראה מדני לאורי חסקל ${tag}`,
  uriOwn: `משימה של אורי חסקל לעצמו ${tag}`,
};

test.describe.serial("teammates can request tasks from each other", () => {
  test("employee sends a request to the admin without seeing his schedule", async ({ browser, request }) => {
    const page = await login(browser, "uri.h@example.com");
    // Dani's card is blurred but has a request button
    await expect(page.getByTestId("card-1").locator(".blurred")).toHaveCount(1);
    await page.getByTestId("card-1").getByRole("button", { name: /בקשת משימה/ }).click();
    await expect(page.getByLabel("איש צוות")).toHaveValue("1");
    await expect(page.getByText(/תופיע אצל דני שקנבסקי כבקשה ממך/)).toBeVisible();
    await expect(page.getByLabel(/משימה קבועה/)).toBeDisabled();
    await page.getByLabel("משימה", { exact: true }).fill(T.uriToDani);
    await page.getByRole("button", { name: "הוספה" }).click();

    // The request shows in "sent" but Dani's card stays blurred
    await expect(page.getByTestId("sent").getByText(T.uriToDani)).toBeVisible();
    await expect(page.getByTestId("card-1").locator(".blurred")).toHaveCount(1);
    await expect(page.getByTestId("card-1").getByText(T.uriToDani)).toHaveCount(0);

    // Opening it shows no status control, only edit/delete
    await page.getByTestId("sent").getByText(T.uriToDani).click();
    await expect(page.getByRole("dialog").getByText("בקשה מעמית")).toBeVisible();
    await expect(page.getByRole("dialog").getByRole("radio", { name: "הושלם" })).toHaveCount(0);
    await expect(page.getByRole("dialog").getByRole("button", { name: "עריכה" })).toBeVisible();
    await page.getByRole("button", { name: "סגירה" }).click();

    // Own task for ordering check later
    await page.getByRole("button", { name: "הוספת משימה", exact: true }).click();
    await page.getByLabel("משימה", { exact: true }).fill(T.uriOwn);
    await page.getByRole("button", { name: "הוספה" }).click();
    await expect(page.getByTestId("card-5").getByText(T.uriOwn)).toBeVisible();

    // API: cannot change status of the request, cannot read Dani's board
    await apiLogin(request, "uri.h@example.com");
    const board = await (await request.get("/api/tasks/board")).json();
    const sentTask = board.sent.find((t: { title: string }) => t.title === T.uriToDani);
    expect(sentTask).toBeTruthy();
    expect(board.tasks.every((t: { assigneeId: number }) => t.assigneeId === 5)).toBeTruthy();
    expect((await request.post(`/api/tasks/${sentTask.id}/status`, { data: { status: "done", note: "" } })).status()).toBe(403);
    // Recurring for someone else is refused
    expect((await request.post("/api/tasks", { data: { title: "x", assigneeId: 1, dueDate: "2030-01-01", weekdays: [0] } })).status()).toBe(403);
    await page.context().close();
  });

  test("admin sees the request at the bottom and his own instructions at the top", async ({ browser }) => {
    const page = await login(browser, "dani@example.com");
    // Request from Uri H sits in the separate peers group of Dani's card
    await expect(page.getByTestId("group-peers-1").getByText(T.uriToDani)).toBeVisible();
    await expect(page.getByTestId("card-1").getByText("בקשות מאנשי צוות אחרים")).toBeVisible();

    // Dani assigns a task to Uri H → top group in Uri's card, above Uri's own task
    await page.getByTestId("card-5").getByRole("button", { name: /הוספת משימה/ }).click();
    await page.getByLabel("משימה", { exact: true }).fill(T.daniToUri);
    await page.getByRole("button", { name: "הוספה" }).click();
    await expect(page.getByTestId("group-management-5").getByText(T.daniToUri)).toBeVisible();
    await expect(page.getByTestId("group-own-5").getByText(T.uriOwn)).toBeVisible();
    const mgmtBox = await page.getByTestId("group-management-5").boundingBox();
    const ownBox = await page.getByTestId("group-own-5").boundingBox();
    expect(mgmtBox!.y).toBeLessThan(ownBox!.y);

    // Dani completes Uri H's request → Uri sees it done in "sent"
    await page.getByTestId("group-peers-1").getByText(T.uriToDani).click();
    await page.getByRole("radio", { name: "הושלם" }).click();
    await page.getByRole("button", { name: "שמירת עדכון" }).click();
    await expect(page.getByRole("dialog").getByText("פתוח ← הושלם")).toBeVisible();
    await page.context().close();

    const uri = await login(browser, "uri.h@example.com");
    const row = uri.getByTestId("sent").locator("li", { hasText: T.uriToDani });
    await expect(row.locator("[aria-label='הושלם']")).toBeVisible();

    // Dani's instruction: employee cannot mark done
    await uri.getByTestId("group-management-5").getByText(T.daniToUri).click();
    await expect(uri.getByRole("dialog").getByRole("radio", { name: "הושלם" })).toBeDisabled();
    await uri.getByRole("button", { name: "סגירה" }).click();

    // A recurring daily task from Dani: employee marks done, no note needed
    const daily = uri.getByTestId("card-5").getByText(/ניקיון חדר כושר/).first();
    await daily.click();
    await expect(uri.getByRole("dialog").getByRole("radio", { name: "הושלם" })).toBeEnabled();
    await uri.getByRole("radio", { name: "הושלם" }).click();
    await uri.getByRole("button", { name: "שמירת עדכון" }).click();
    await expect(uri.getByRole("dialog").getByText("פתוח ← הושלם")).toBeVisible();
    await uri.context().close();
  });
});
