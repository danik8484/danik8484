import { test, expect } from "@playwright/test";

test("admin creates a one-time login link and it signs the teammate in", async ({ browser, request }) => {
  const r = await request.post("/api/auth/request-code", { data: { email: "dani@example.com" } });
  const { devCode } = await r.json();
  expect((await request.post("/api/auth/verify", { data: { email: "dani@example.com", code: devCode } })).ok()).toBeTruthy();
  const res = await request.post("/api/users/4/login-link");
  expect(res.status()).toBe(200);
  const { url } = await res.json();
  expect(url).toMatch(/\/login\?t=[0-9a-f]{64}$/);

  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(url);
  await expect(page.getByTestId("card-4")).toBeVisible();
  await expect(page.getByTestId("card-4").getByText("(אני)")).toBeVisible();
  await expect(page.getByTestId("card-1").locator(".blurred")).toHaveCount(1);
  await ctx.close();

  // Single use
  const again = await browser.newContext();
  const p2 = await again.newPage();
  await p2.goto(url);
  await expect(p2.getByText("הקישור כבר נוצל")).toBeVisible();
  await again.close();

  // Employees cannot mint links
  await request.post("/api/auth/logout");
  const r2 = await request.post("/api/auth/request-code", { data: { email: "uri.h@example.com" } });
  const { devCode: c2 } = await r2.json();
  await request.post("/api/auth/verify", { data: { email: "uri.h@example.com", code: c2 } });
  expect((await request.post("/api/users/1/login-link")).status()).toBe(403);
});
