import { test, expect, type APIRequestContext } from "@playwright/test";
import http from "node:http";

/**
 * DND CASH integration, against a stand-in server that behaves like the real one: e-mail-code sign-in is replaced by
 * a known refresh token, every refresh ROTATES the token (the old one is refused), access tokens are checked on every
 * call, and POST /api/deals records what it was given. The real DND CASH is never touched by these tests.
 */
const MOCK_PORT = 8790;
const MOCK_URL = `http://localhost:${MOCK_PORT}`;
const ADMIN = 1;
const RON = 2;
const URI_S = 3;
const URI_H = 5;

type Rec = { method: string; path: string; body: Record<string, unknown> | null; auth: string | null; cookie: string | null };
const state = { refresh: "rt-1", access: "", refreshes: 0, requests: [] as Rec[], deals: [] as Record<string, unknown>[], failedOnce: new Set<string>() };

function b64(s: string) {
  return Buffer.from(s).toString("base64url");
}
/** An access token the worker will always treat as "about to expire", so every sync has to refresh (and rotate). */
function accessToken(n: number) {
  return `${b64(JSON.stringify({ alg: "HS256" }))}.${b64(JSON.stringify({ sub: "mock", exp: Math.floor(Date.now() / 1000) - 1, n }))}.sig`;
}

let server: http.Server;
let admin: APIRequestContext;

test.beforeAll(async ({ playwright }) => {
  admin = await playwright.request.newContext({ baseURL: process.env.BASE_URL || "http://localhost:8787" });
  server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const url = new URL(req.url || "/", MOCK_URL);
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      const json = (status: number, data: unknown, headers: Record<string, string | string[]> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(data));
      };
      if (url.pathname === "/__requests") return json(200, state.requests);
      if (url.pathname === "/__deals") return json(200, state.deals);
      if (url.pathname === "/__reset") {
        state.refresh = "rt-1";
        state.access = "";
        state.refreshes = 0;
        state.requests = [];
        state.deals = [];
        state.failedOnce.clear();
        return json(200, { ok: true });
      }
      state.requests.push({ method: req.method || "", path: url.pathname + url.search, body, auth: req.headers.authorization ?? null, cookie: req.headers.cookie ?? null });
      if (url.pathname === "/api/auth/refresh") {
        const m = /dndcash_refresh=([^;]+)/.exec(req.headers.cookie || "");
        if (!m || m[1] !== state.refresh) return json(401, { error: "INVALID_REFRESH_TOKEN" });
        state.refreshes++;
        state.refresh = `rt-${state.refreshes + 1}`;
        state.access = accessToken(state.refreshes);
        return json(
          200,
          { accessToken: state.access, user: { id: "u1", email: "owner@example.com", role: "ADMIN", displayName: "בדיקה" } },
          { "set-cookie": [`dndcash_refresh=${state.refresh}; Max-Age=31536000; Path=/api/auth; HttpOnly; Secure; SameSite=Lax`, "dndcash_refresh=; Max-Age=0; Path=/api/auth/refresh; SameSite=Lax"] },
        );
      }
      if (!state.access || req.headers.authorization !== `Bearer ${state.access}`) return json(401, { error: "UNAUTHORIZED" });
      if (url.pathname === "/api/auth/me") return json(200, { id: "u1", email: "owner@example.com", role: "ADMIN", displayName: "בדיקה", isActive: true });
      if (url.pathname === "/api/agents")
        return json(200, {
          items: [
            { id: "agent-ron", email: "ron@example.com", displayName: "Ron", isActive: true, deletedAt: null },
            { id: "agent-uri", email: "uri.h@example.com", displayName: "אורי חסקל", isActive: true, deletedAt: null },
            { id: "agent-old", email: "old@example.com", displayName: "ישן", isActive: false, deletedAt: null },
          ],
        });
      if (url.pathname === "/api/deals" && req.method === "POST") {
        const name = String(body?.clientName ?? "");
        if (name.startsWith("FAIL500ONCE") && !state.failedOnce.has(name)) {
          state.failedOnce.add(name);
          return json(500, { error: "INTERNAL" });
        }
        if (name.startsWith("FAIL400")) return json(400, { error: "INVALID_TOTAL_AMOUNT" });
        const deal = { id: `deal-${state.deals.length + 1}`, status: "PENDING", ...(body ?? {}) };
        state.deals.push(deal);
        return json(201, deal);
      }
      if (url.pathname === "/api/deals" && req.method === "GET") {
        const q = (url.searchParams.get("search") || "").toLowerCase();
        const items = state.deals.filter((d) => !q || String(d.clientName).toLowerCase().includes(q));
        return json(200, { items, total: items.length, pagination: { page: 1, pageSize: 100, totalPages: 1 } });
      }
      json(404, { error: "NOT_FOUND" });
    });
  });
  await new Promise<void>((r) => server.listen(MOCK_PORT, r));
});

test.afterAll(async () => {
  await admin.dispose();
  await new Promise<void>((r) => server.close(() => r()));
});

async function apiLogin(request: APIRequestContext, userId: number) {
  await request.post("/api/auth/logout");
  const r = await request.post("/api/auth/request-code", { data: { userId } });
  const { devCode } = await r.json();
  expect(devCode, `dev code for user ${userId}`).toBeTruthy();
  expect((await request.post("/api/auth/verify", { data: { userId, code: devCode } })).ok()).toBeTruthy();
}

async function mock(request: APIRequestContext, path: string) {
  return (await request.get(`${MOCK_URL}${path}`)).json();
}

/**
 * Run the sync now, as the admin, and wait for it. (The app also starts a sync in the background right after a deal
 * is saved and every 5 minutes from the cron; in the local dev server background fetches to localhost are cut off
 * when the request ends, so the tests drive the sync explicitly.)
 */
async function sync(_request: APIRequestContext) {
  const r = await admin.post("/api/settings/dnd/sync");
  expect(r.ok()).toBeTruthy();
  return (await r.json()).result as { sent: number; failed: number; pending: number } | null;
}

async function leadsTask(request: APIRequestContext, assigneeId: number, today: string, title: string): Promise<number> {
  const r = await request.post("/api/tasks", { data: { title, assigneeId, dueDate: today, kind: "leads" } });
  expect(r.ok()).toBeTruthy();
  return (await r.json()).task.id;
}

async function task(request: APIRequestContext, id: number) {
  return (await (await request.get(`/api/tasks/${id}`)).json()).task;
}

/** The sync that starts right after a save runs in the background: wait (up to ~6s) until the deals reach the expected state. */
type DndState = { status?: string; attempts?: number };
async function settled(request: APIRequestContext, id: number, ready: (deals: DndState[]) => boolean) {
  let t = await task(request, id);
  for (let i = 0; i < 24 && !ready(t.deals.map((d: { dnd?: DndState }) => d.dnd ?? {})); i++) {
    await new Promise((r) => setTimeout(r, 250));
    t = await task(request, id);
  }
  return t;
}
const noneP = (deals: DndState[]) => deals.every((d) => d.status !== "pending");

const unique = Date.now().toString().slice(-6);

test.describe.serial("DND CASH: a closed deal saved here becomes a new deal there", () => {
  let today = "";
  let ronTask = 0;
  let uriHTask = 0;
  let dealKeyRon = "";

  test("the admin connects the app to DND CASH with a refresh token; the app learns the agents", async ({ request }) => {
    await mock(request, "/__reset");
    await apiLogin(admin, ADMIN);
    await apiLogin(request, ADMIN);
    today = (await (await request.get("/api/me")).json()).today;
    // a real address must be https; the stand-in is allowed only in development
    expect((await request.put("/api/settings", { data: { dndBaseUrl: "ftp://nope" } })).status()).toBe(400);
    expect((await request.put("/api/settings", { data: { dndBaseUrl: MOCK_URL, dndPlusTrainingUserIds: [RON] } })).ok()).toBeTruthy();
    expect((await request.post("/api/settings/dnd/connect", { data: { refreshToken: "wrong" } })).status()).toBe(502);
    const c = await request.post("/api/settings/dnd/connect", { data: { refreshToken: "rt-1" } });
    expect(c.ok()).toBeTruthy();
    const { dnd } = await c.json();
    expect(dnd.connected).toBeTruthy();
    expect(dnd.user.displayName).toBe("בדיקה");
    expect(dnd.agents.map((a: { id: string }) => a.id).sort()).toEqual(["agent-old", "agent-ron", "agent-uri"]);
    const me = await (await request.get("/api/me")).json();
    expect(me.features.dndConnected).toBeTruthy();
    expect(me.features.plusTrainingUserIds).toEqual([RON]);
    const settings = await (await request.get("/api/settings")).json();
    expect(settings.dnd.connected).toBeTruthy();
    expect(settings.dndPlusTrainingUserIds).toEqual([RON]);
  });

  test("Ron saves two deals: a 10-month standing order with training, and a cash sale – both land in DND CASH under his agent", async ({ request }) => {
    await apiLogin(request, RON);
    ronTask = await leadsTask(request, RON, today, `לידים של רון ${unique}`);
    // a standing order without months is refused; training is allowed for Ron
    expect((await request.post(`/api/tasks/${ronTask}/status`, { data: { status: "in_progress", note: "עובד", deals: [{ name: "קלוד בדיקה", amount: 4800, method: "standing_order" }] } })).status()).toBe(400);
    const r = await request.post(`/api/tasks/${ronTask}/status`, {
      data: {
        status: "in_progress",
        note: "עובד",
        deals: [
          { name: "קלוד בדיקה", amount: 4800, method: "standing_order", months: 10, plusTraining: true },
          { name: "אבי כהן", amount: 1000, method: "cash" },
        ],
      },
    });
    expect(r.ok()).toBeTruthy();
    const saved = (await r.json()).task;
    expect(saved.deals).toHaveLength(2);
    expect(saved.deals[0].key).toMatch(/^[a-f0-9]{16}$/);
    expect(saved.deals[0].dnd.status).toBe("pending");
    dealKeyRon = saved.deals[0].key;
    await sync(request);
    const t = await settled(request, ronTask, noneP);
    expect(t.deals[0].dnd.status).toBe("sent");
    expect(t.deals[0].dnd.id).toBe("deal-1");
    expect(t.deals[1].dnd.status).toBe("sent");
    expect(t.deals[1].dnd.id).toBe("deal-2");
    const posted = ((await mock(request, "/__requests")) as Rec[]).filter((q) => q.method === "POST" && q.path === "/api/deals").map((q) => q.body);
    expect(posted).toHaveLength(2);
    expect(posted[0]).toMatchObject({
      clientName: "קלוד בדיקה",
      totalAmount: 4800,
      dealType: "SALES_PLUS_TRAINING",
      paymentMethod: "STANDING_ORDER",
      agentId: "agent-ron",
      closedAt: `${today}T00:00:00.000Z`,
      standingOrderMonths: 10,
      firstDueDate: today,
    });
    expect(String(posted[0]!.notes)).toContain(`[לוז #${ronTask}/${dealKeyRon}]`);
    expect(posted[1]).toMatchObject({ clientName: "אבי כהן", totalAmount: 1000, dealType: "SALES_ONLY", paymentMethod: "CASH", agentId: "agent-ron", closedAt: `${today}T00:00:00.000Z` });
    expect(posted[1]).not.toHaveProperty("standingOrderMonths");
  });

  test("editing a deal after it was sent never touches DND CASH; it is only flagged", async ({ request }) => {
    await apiLogin(request, RON);
    const before = ((await mock(request, "/__requests")) as Rec[]).filter((q) => q.method === "POST" && q.path === "/api/deals").length;
    const t = await task(request, ronTask);
    const edited = t.deals.map((d: Record<string, unknown>, i: number) => (i === 0 ? { ...d, amount: 5000 } : d));
    expect((await request.post(`/api/tasks/${ronTask}/status`, { data: { status: "in_progress", note: "עודכן", deals: edited } })).ok()).toBeTruthy();
    await sync(request);
    const after = await settled(request, ronTask, noneP);
    expect(after.deals[0].amount).toBe(5000);
    expect(after.deals[0].dnd).toMatchObject({ status: "sent", id: "deal-1", stale: true });
    expect(after.deals[1].dnd).toMatchObject({ status: "sent", id: "deal-2" });
    expect(after.deals[1].dnd.stale).toBeUndefined();
    expect(((await mock(request, "/__requests")) as Rec[]).filter((q) => q.method === "POST" && q.path === "/api/deals").length).toBe(before);
  });

  test("only the people on the list may mark 'sales + training'; a teammate without an agent lands as a direct deal", async ({ request }) => {
    await apiLogin(request, URI_S);
    const id = await leadsTask(request, URI_S, today, `לידים של אורי ש ${unique}`);
    const denied = await request.post(`/api/tasks/${id}/status`, { data: { status: "in_progress", note: "עובד", deals: [{ name: "דנה לוי", amount: 700, method: "bank_transfer", plusTraining: true }] } });
    expect(denied.status()).toBe(400);
    expect((await denied.json()).error).toContain("מכירה + אימון");
    expect((await request.post(`/api/tasks/${id}/status`, { data: { status: "in_progress", note: "עובד", deals: [{ name: "דנה לוי", amount: 700, method: "bank_transfer" }] } })).ok()).toBeTruthy();
    await sync(request);
    expect((await settled(request, id, noneP)).deals[0].dnd.status).toBe("sent");
    const posted = ((await mock(request, "/__requests")) as Rec[]).filter((q) => q.method === "POST" && q.path === "/api/deals").map((q) => q.body);
    const mine = posted.find((b) => b!.clientName === "דנה לוי")!;
    expect(mine).toMatchObject({ dealType: "SALES_ONLY", paymentMethod: "BANK_TRANSFER", agentId: null });
  });

  test("a temporary failure is retried and adopted; a rejected deal shows the reason and is retried only after an edit", async ({ request }) => {
    await apiLogin(request, URI_H);
    uriHTask = await leadsTask(request, URI_H, today, `לידים של אורי ח ${unique}`);
    expect(
      (
        await request.post(`/api/tasks/${uriHTask}/status`, {
          data: {
            status: "in_progress",
            note: "עובד",
            deals: [
              { name: "FAIL500ONCE יוסי", amount: 300, method: "credit_card" },
              { name: "FAIL400 משה", amount: 400, method: "paypal" },
            ],
          },
        })
      ).ok(),
    ).toBeTruthy();
    await sync(request);
    let t = await settled(request, uriHTask, (d) => (d[0]?.attempts ?? 0) >= 1 && d[1]?.status === "error");
    expect(t.deals[0].dnd).toMatchObject({ status: "pending", attempts: 1 }); // 500 → try again later
    expect(t.deals[0].dnd.error).toContain("500");
    expect(t.deals[1].dnd).toMatchObject({ status: "error", error: "הסכום לא תקין" }); // 400 → the cron leaves it alone
    await sync(request); // "sync now" gives rejected deals another go too
    t = await settled(request, uriHTask, (d) => d[0]?.status === "sent");
    expect(t.deals[0].dnd).toMatchObject({ status: "sent", attempts: 2 });
    expect(t.deals[0].dnd.id).toBeTruthy();
    expect(t.deals[1].dnd).toMatchObject({ status: "error", attempts: 2 });
    // the retry looked for an already-created deal before posting again (no duplicate)
    const posted = ((await mock(request, "/__requests")) as Rec[]).filter((q) => q.method === "POST" && q.path === "/api/deals" && String(q.body?.clientName).startsWith("FAIL500ONCE"));
    expect(posted).toHaveLength(2); // one failed, one succeeded
    expect(((await mock(request, "/__deals")) as Record<string, unknown>[]).filter((d) => String(d.clientName).startsWith("FAIL500ONCE"))).toHaveLength(1);
    // fixing the rejected deal (same key) makes it pending again and it goes through
    const fixed = t.deals.map((d: Record<string, unknown>, i: number) => (i === 1 ? { ...d, name: "משה פרץ" } : d));
    expect((await request.post(`/api/tasks/${uriHTask}/status`, { data: { status: "in_progress", note: "תוקן", deals: fixed } })).ok()).toBeTruthy();
    await sync(request);
    t = await settled(request, uriHTask, noneP);
    expect(t.deals[1]).toMatchObject({ name: "משה פרץ", dnd: { status: "sent" } });
    const uriHPosted = ((await mock(request, "/__requests")) as Rec[]).filter((q) => q.method === "POST" && q.path === "/api/deals" && q.body?.clientName === "משה פרץ").map((q) => q.body);
    expect(uriHPosted[0]).toMatchObject({ agentId: "agent-uri", paymentMethod: "PAYPAL" });
  });

  test("the refresh token rotates on every use and the stored one always works; the deals page and settings show the state", async ({ request }) => {
    const reqs = (await mock(request, "/__requests")) as Rec[];
    // (the very first attempt used a deliberately wrong token and was refused – skip it)
    const refreshes = reqs.filter((q) => q.path === "/api/auth/refresh" && !(q.cookie || "").includes("=wrong"));
    expect(refreshes.length).toBeGreaterThanOrEqual(3);
    // every refresh used the token issued by the previous one (no reuse of a dead token → no 401 from the stand-in)
    const cookies = refreshes.map((q) => /dndcash_refresh=([^;]+)/.exec(q.cookie || "")?.[1]);
    expect(cookies[0]).toBe("rt-1");
    for (let i = 1; i < cookies.length; i++) expect(cookies[i]).toBe(`rt-${i + 1}`);
    await apiLogin(request, ADMIN);
    const t = await request.post("/api/settings/dnd/test");
    expect(t.ok()).toBeTruthy();
    expect((await t.json()).dnd.user.displayName).toBe("בדיקה");
    const deals = await (await request.get(`/api/deals?from=${today}&to=${today}`)).json();
    const ron = deals.deals.find((d: { name: string }) => d.name === "קלוד בדיקה");
    expect(ron).toMatchObject({ months: 10, plusTraining: true, dnd: { status: "sent", id: "deal-1", stale: true } });
    const summary = await request.post("/api/settings/dnd/sync");
    expect(summary.ok()).toBeTruthy();
    expect((await summary.json()).dnd.lastSyncAt).toBeTruthy();
  });

  test("in the browser: Ron sees the standing-order fields, the training checkbox and the DND CASH state", async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto("/");
    await page.getByTestId("team-picker").getByRole("button", { name: "רון וליצ'קו", exact: true }).click();
    await page.getByRole("button", { name: "שלח לי קוד לוואטסאפ" }).click();
    await expect(page.getByTestId("dev-code")).toBeVisible();
    const code = (await page.getByTestId("dev-code").locator("b").textContent())!.trim();
    await page.getByLabel("קוד אימות").fill(code);
    await page.getByRole("button", { name: "כניסה" }).click();
    await expect(page.getByTestId(`card-${RON}`)).toBeVisible();
    await page.getByTestId(`task-${ronTask}`).first().click();
    await expect(page.getByTestId("deal-so-0")).toBeVisible();
    await expect(page.getByTestId("deal-months-0")).toHaveValue("10");
    await expect(page.getByTestId("deal-plus-0")).toBeChecked();
    await expect(page.getByTestId("deal-dnd-0")).toContainText("נשלח ל-DND CASH");
    await expect(page.getByTestId("deal-dnd-0")).toContainText("שונה אחרי השליחה");
    await expect(page.getByTestId("deal-dnd-1")).toContainText("נשלח ל-DND CASH");
    await ctx.close();
  });

  test("disconnecting stops new deals from being sent; settings go back to normal for the other specs", async ({ request }) => {
    await apiLogin(request, ADMIN);
    expect((await request.post("/api/settings/dnd/disconnect")).ok()).toBeTruthy();
    expect((await (await request.get("/api/me")).json()).features.dndConnected).toBeFalsy();
    const id = await leadsTask(request, ADMIN, today, `לידים אחרי ניתוק ${unique}`);
    expect((await request.post(`/api/tasks/${id}/status`, { data: { status: "in_progress", note: "עובד", deals: [{ name: "רות שמש", amount: 200, method: "cash" }] } })).ok()).toBeTruthy();
    expect((await task(request, id)).deals[0].dnd).toBeUndefined();
    expect((await request.put("/api/settings", { data: { dndPlusTrainingUserIds: [] } })).ok()).toBeTruthy();
    for (const tid of [ronTask, uriHTask, id]) expect((await request.delete(`/api/tasks/${tid}`, { data: { reason: "ניקוי בדיקה" } })).ok()).toBeTruthy();
  });
});
