import { test, type Browser } from "@playwright/test";

const OUT = process.env.SHOT_DIR || "screenshots";

async function login(browser: Browser, email: string) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByLabel("כתובת מייל").fill(email);
  await page.getByRole("button", { name: "שלח לי קוד" }).click();
  const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
  await page.getByLabel("קוד כניסה").fill(code);
  await page.getByRole("button", { name: "כניסה" }).click();
  await page.getByTestId("card-1").waitFor();
  await page.waitForTimeout(400);
  return page;
}

test.skip(!process.env.SHOT_DIR, "screenshots only on demand");

test("screenshots", async ({ browser }) => {
  const dani = await login(browser, "dani@example.com");
  await dani.screenshot({ path: `${OUT}/1-admin-board.png`, fullPage: true });
  await dani.getByTestId("card-3").locator("[data-testid^=task-]").first().click();
  await dani.waitForTimeout(500);
  await dani.screenshot({ path: `${OUT}/2-admin-task.png` });
  await dani.getByRole("button", { name: "סגירה" }).click();
  await dani.getByRole("button", { name: "תפריט" }).click();
  await dani.getByRole("link", { name: "יומן פעילות" }).click();
  await dani.waitForTimeout(500);
  await dani.screenshot({ path: `${OUT}/3-admin-log.png`, fullPage: true });
  await dani.context().close();

  const ron = await login(browser, "ron@example.com");
  await ron.screenshot({ path: `${OUT}/4-ron-board.png`, fullPage: true });
  await ron.context().close();

  const uri = await login(browser, "uri.s@example.com");
  await uri.getByRole("button", { name: "הוספת משימה", exact: true }).click();
  await uri.waitForTimeout(400);
  await uri.screenshot({ path: `${OUT}/5-employee-add.png` });
  await uri.context().close();

  const ctx = await browser.newContext();
  const login2 = await ctx.newPage();
  await login2.goto("/");
  await login2.screenshot({ path: `${OUT}/0-login.png` });
});
