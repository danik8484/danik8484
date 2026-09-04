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
    const r = await request.post(`/api/tasks/${inst.id}/status`, { data: { status: "done", note: "", metricDeals: 3, metricCalls: 25 } });
    expect(r.status()).toBe(200);
    const detail = await (await request.get(`/api/tasks/${inst.id}`)).json();
    expect(detail.task.metricDeals).toBe(3);
    expect(detail.task.metricCalls).toBe(25);
    expect(detail.events.some((e: { note: string }) => e.note.includes("נסלקים: 3"))).toBeTruthy();
    // Done without metrics is fine too
    expect((await request.post(`/api/tasks/${inst.id}/status`, { data: { status: "open", note: "", metricDeals: null, metricCalls: null } })).status()).toBe(200);
    expect((await request.post(`/api/tasks/${inst.id}/status`, { data: { status: "done", note: "" } })).status()).toBe(200);
  }
});
