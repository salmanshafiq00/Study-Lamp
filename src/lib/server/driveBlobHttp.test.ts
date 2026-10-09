import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { fetchWithRetry, retryDelayMs, throwForStatus } from "./driveBlobHttp";

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

describe("fetchWithRetry", () => {
  it("retries 429/5xx with backoff and honours Retry-After", async () => {
    const sleeps: number[] = [];
    const queue = [res(429, {}, { "retry-after": "2" }), res(503), res(200, { ok: 1 })];
    const response = await fetchWithRetry((async () => queue.shift()!) as unknown as typeof fetch, "https://x", {}, { sleep: async (ms) => { sleeps.push(ms); }, random: () => 0 });
    assert.equal(response.status, 200);
    assert.deepEqual(sleeps, [2000, 1000]);
  });

  it("gives up after 3 retries and returns the last response", async () => {
    let calls = 0;
    const response = await fetchWithRetry((async () => { calls++; return res(500); }) as unknown as typeof fetch, "https://x", {}, { sleep: async () => {}, random: () => 0 });
    assert.equal(response.status, 500);
    assert.equal(calls, 4);
  });

  it("does not retry a plain 403 or 404", async () => {
    let calls = 0;
    await fetchWithRetry((async () => { calls++; return res(403, { error: { errors: [{ reason: "insufficientPermissions" }] } }); }) as unknown as typeof fetch, "https://x", {}, { sleep: async () => {} });
    assert.equal(calls, 1);
  });

  it("retries a rate-limit 403", async () => {
    const queue = [res(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }), res(200)];
    const response = await fetchWithRetry((async () => queue.shift()!) as unknown as typeof fetch, "https://x", {}, { sleep: async () => {}, random: () => 0 });
    assert.equal(response.status, 200);
  });

  it("backoff doubles per attempt", () => {
    assert.equal(retryDelayMs(res(500), 0, { random: () => 0 }), 500);
    assert.equal(retryDelayMs(res(500), 2, { random: () => 0 }), 2000);
  });
});

describe("throwForStatus", () => {
  it("classifies statuses without leaking bodies", async () => {
    await assert.rejects(throwForStatus(res(401)), { code: "auth", status: 401 });
    await assert.rejects(throwForStatus(res(404)), { code: "not_found" });
    await assert.rejects(throwForStatus(res(403, { error: { errors: [{ reason: "storageQuotaExceeded" }] } })), { code: "quota" });
    await assert.rejects(throwForStatus(res(403, { error: { errors: [{ reason: "insufficientPermissions" }], message: "secret detail" } })), (error: Error) => {
      assert.equal((error as { code?: string }).code, "scope_missing");
      assert.ok(!error.message.includes("secret"));
      return true;
    });
    await assert.rejects(throwForStatus(res(500)), { code: "upstream" });
  });
});
