import { test, expect, type APIRequestContext } from "@playwright/test";

async function apiLogin(request: APIRequestContext, email: string) {
  const r = await request.post("/api/auth/request-code", { data: { email } });
  const { devCode } = await r.json();
  expect((await request.post("/api/auth/verify", { data: { email, code: devCode } })).ok()).toBeTruthy();
}

test("new-task notifications are queued per recipient and flushed as one digest", async ({ request }) => {
  // Uri H registers a (fake) push device
  await apiLogin(request, "uri.h@example.com");
  const cfg = await (await request.get("/api/push/config")).json();
  expect(cfg.publicKey).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  const sub = await request.post("/api/push/subscribe", {
    data: { endpoint: "https://localhost:1/push/fake-" + Date.now(), keys: { p256dh: "BNrdmQvoQZvA3iM4pEq4Yp7cqf2P1J5YlH0m0f7d2ZlG7X2aWl5kQqL6cW1pQq7Q8Y9Zs2X3kX7Yq2b3C4d5E6F", auth: "c2VjcmV0MTIzNDU2Nzg" } },
  });
  expect(sub.status()).toBe(200);
  expect((await request.get("/api/push/pending")).ok()).toBeTruthy();
  await request.post("/api/auth/logout");

  // Dani adds three tasks in a row for Uri H
  await apiLogin(request, "dani@example.com");
  for (const t of ["א", "ב", "ג"]) {
    expect((await request.post("/api/tasks", { data: { title: `דחוף ${t} ${Date.now()}`, assigneeId: 5, dueDate: "2030-01-02" } })).status()).toBe(201);
  }
  await request.post("/api/auth/logout");

  await apiLogin(request, "uri.h@example.com");
  const before = await (await request.get("/api/push/pending")).json();
  expect(before.pending).toBeGreaterThanOrEqual(3);

  // Cron with debounce still holds them (too recent); forced dev cron flushes as one digest
  expect((await request.get("/__scheduled?cron=*/5+*+*+*+*")).ok()).toBeTruthy();
  expect((await (await request.get("/api/push/pending")).json()).pending).toBeGreaterThanOrEqual(3);
  expect((await request.get("/__scheduled?cron=force")).ok()).toBeTruthy();
  expect((await (await request.get("/api/push/pending")).json()).pending).toBe(0);

  await request.post("/api/push/unsubscribe", { data: { endpoint: "irrelevant" } });
});

test("login codes cannot be brute-forced and forms cannot post JSON endpoints", async ({ request }) => {
  const email = "dani.k@example.com";
  const r = await request.post("/api/auth/request-code", { data: { email } });
  const { devCode } = await r.json();
  // 5 wrong guesses in parallel, then the right code must be refused as well
  const wrong = await Promise.all(Array.from({ length: 6 }, (_, i) => request.post("/api/auth/verify", { data: { email, code: String(100000 + i) } })));
  expect(wrong.every((w) => w.status() === 401)).toBeTruthy();
  const late = await request.post("/api/auth/verify", { data: { email, code: devCode } });
  expect(late.status()).toBe(401);
  // Unknown addresses look exactly like known ones
  const unknown = await request.post("/api/auth/request-code", { data: { email: "nobody@example.com" } });
  expect(unknown.status()).toBe(200);
  expect(await unknown.json()).toEqual({ ok: true });
  // A form-encoded post (what a cross-site HTML form can send) is refused
  const form = await request.post("/api/auth/verify", { headers: { "content-type": "text/plain" }, data: '{"email":"x","code":"1"}' });
  expect(form.status()).toBe(415);
});

test("employees cannot reopen a task the manager closed", async ({ request }) => {
  await apiLogin(request, "dani@example.com");
  const created = await (await request.post("/api/tasks", { data: { title: "סגורה על ידי המנהל", assigneeId: 5, dueDate: "2030-03-01" } })).json();
  expect((await request.post(`/api/tasks/${created.task.id}/status`, { data: { status: "done", note: "" } })).status()).toBe(200);
  await request.post("/api/auth/logout");
  await apiLogin(request, "uri.h@example.com");
  expect((await request.post(`/api/tasks/${created.task.id}/status`, { data: { status: "open", note: "" } })).status()).toBe(403);
  expect((await request.post(`/api/tasks/${created.task.id}/status`, { data: { status: "in_progress", note: "עוד עבודה" } })).status()).toBe(403);
});

test("leads task carries deal/call counts, optional", async ({ request }) => {
  await apiLogin(request, "ron@example.com");
  const rec = await (await request.get("/api/recurring")).json();
  const leads = rec.recurring.find((r: { kind: string; assigneeId: number }) => r.kind === "leads" && r.assigneeId === 2);
  expect(leads).toBeTruthy();
  expect(leads.weekdays).toEqual([0, 1, 2, 3, 4, 5]);

  // Any leads task instance on Ron's board today? Create a one-off leads-like check through a recurring instance if present, else skip metrics UI check
  const board = await (await request.get("/api/tasks/board")).json();
  const inst = board.tasks.find((t: { kind: string; assigneeId: number }) => t.kind === "leads" && t.assigneeId === 2);
  if (inst) {
    const r = await request.post(`/api/tasks/${inst.id}/status`, {
      data: { status: "done", note: "", deals: [{ name: "דוד", amount: 1200 }, { name: "מיה", amount: null }, { name: "יוסי", amount: "800" }], metricCalls: 25 },
    });
    expect(r.status()).toBe(200);
    const detail = await (await request.get(`/api/tasks/${inst.id}`)).json();
    expect(detail.task.metricDeals).toBe(3);
    expect(detail.task.deals).toEqual([{ name: "דוד", amount: 1200 }, { name: "מיה", amount: null }, { name: "יוסי", amount: 800 }]);
    expect(detail.task.metricCalls).toBe(25);
    expect(detail.events.some((e: { note: string }) => e.note.includes("נסלקים: 3") && e.note.includes("דוד 1200₪"))).toBeTruthy();
    // Validation: a deal without a name, a fractional call count
    expect((await request.post(`/api/tasks/${inst.id}/status`, { data: { status: "done", note: "", deals: [{ name: "", amount: 5 }] } })).status()).toBe(400);
    expect((await request.post(`/api/tasks/${inst.id}/status`, { data: { status: "done", note: "", metricCalls: 3.5 } })).status()).toBe(400);
    // Done without any metrics is fine too (recurring: employee may reopen/close)
    expect((await request.post(`/api/tasks/${inst.id}/status`, { data: { status: "open", note: "", deals: [], metricCalls: null } })).status()).toBe(200);
    expect((await (await request.get(`/api/tasks/${inst.id}`)).json()).task.deals).toEqual([]);
    expect((await request.post(`/api/tasks/${inst.id}/status`, { data: { status: "done", note: "" } })).status()).toBe(200);
  }
});
