import { test, expect, type APIRequestContext } from "@playwright/test";

const NAME: Record<string, string> = {
  "dani@example.com": "דני שקנבסקי",
  "ron@example.com": "רון וליצ'קו",
  "uri.s@example.com": "אורי שפירא",
  "dani.k@example.com": "דני קגנוביץ",
  "uri.h@example.com": "אורי חסקל",
};

async function apiLogin(request: APIRequestContext, email: string) {
  const r = await request.post("/api/auth/request-code", { data: { email } });
  const { devCode } = await r.json();
  expect((await request.post("/api/auth/verify", { data: { email, code: devCode } })).ok()).toBeTruthy();
}

// 1x1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("photos can be attached to a task, viewed by permitted users, and removed", async ({ browser, request }) => {
  await apiLogin(request, "uri.h@example.com");
  const title = `משימה עם תמונה ${Date.now().toString().slice(-6)}`;
  const created = await (await request.post("/api/tasks", { data: { title, assigneeId: 5, dueDate: "2030-01-01" } })).json();
  const id = created.task.id;

  const up = await request.post(`/api/tasks/${id}/photos`, { headers: { "content-type": "image/png", "x-file-name": "proof.png" }, data: PNG });
  expect(up.status()).toBe(201);
  const { attachment } = await up.json();
  expect((await request.post(`/api/tasks/${id}/photos`, { headers: { "content-type": "text/plain" }, data: "hi" })).status()).toBe(415);

  const detail = await (await request.get(`/api/tasks/${id}`)).json();
  expect(detail.attachments).toHaveLength(1);
  const img = await request.get(`/api/photos/${attachment.id}`);
  expect(img.status()).toBe(200);
  expect(img.headers()["content-type"]).toBe("image/png");
  expect((await img.body()).length).toBe(PNG.length);

  // Admin sees it in the sheet; Uri Shapira (no permission) cannot fetch it
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/");
  await page.getByTestId("team-picker").getByRole("button", { name: NAME["dani@example.com"], exact: true }).click();
  await page.getByRole("button", { name: "שלח לי קוד לוואטסאפ" }).click();
  await expect(page.getByTestId("dev-code")).toBeVisible();
  const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
  await page.getByLabel("קוד אימות").fill(code);
  await page.getByRole("button", { name: "כניסה" }).click();
  await expect(page.getByTestId("card-1")).toBeVisible();
  await page.getByText("משימות עתידיות").click();
  await page.getByTestId(`task-${id}`).click();
  await expect(page.getByTestId("photos").getByRole("img")).toHaveCount(1);
  await ctx.close();

  const other = await request.post("/api/auth/logout");
  expect(other.ok()).toBeTruthy();
  await apiLogin(request, "uri.s@example.com");
  expect((await request.get(`/api/photos/${attachment.id}`)).status()).toBe(403);
  expect((await request.delete(`/api/photos/${attachment.id}`)).status()).toBe(403);

  await request.post("/api/auth/logout");
  await apiLogin(request, "uri.h@example.com");
  expect((await request.delete(`/api/photos/${attachment.id}`)).status()).toBe(200);
  expect((await request.get(`/api/photos/${attachment.id}`)).status()).toBe(404);
});
