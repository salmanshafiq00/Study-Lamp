import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DELETE_BATCH_SIZE, THUMBNAIL_BATCH_SIZE, attemptCutoffMs, chunk, keepNewestCutoffMs, parseCleanupRequest, previewCleanup, runCleanup,
  type CleanupAction, type CleanupDeps,
} from "./storageCleanup";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 10);

describe("parseCleanupRequest", () => {
  it("accepts known actions and defaults months to 12", () => {
    assert.deepEqual(parseCleanupRequest({ action: "quiz_attempts" }), { action: "quiz_attempts", params: { months: 12 } });
    assert.deepEqual(parseCleanupRequest({ action: "quiz_attempts", months: 6 }), { action: "quiz_attempts", params: { months: 6 } });
  });
  it("rejects unknown actions and bad months", () => {
    assert.equal(parseCleanupRequest({ action: "drop_everything" }), null);
    assert.equal(parseCleanupRequest({ action: "quiz_attempts", months: 0 }), null);
    assert.equal(parseCleanupRequest({ action: "quiz_attempts", months: 1.5 }), null);
    assert.equal(parseCleanupRequest({ action: "quiz_attempts", months: "12" }), null);
    assert.equal(parseCleanupRequest({}), null);
  });
});

describe("attemptCutoffMs (age cutoff + keep newest 200)", () => {
  const times = (n: number, newestAgeDays: number) => Array.from({ length: n }, (_, i) => NOW - (newestAgeDays + i) * DAY);
  it("deletes nothing when there are fewer than 200 attempts", () => {
    assert.equal(attemptCutoffMs({ nowMs: NOW, months: 12, newestTimesDesc: times(199, 400) }), null);
  });
  it("keeps the newest 200 even when they are older than the age cutoff", () => {
    const newest = times(200, 400); // all older than 12 months
    assert.equal(attemptCutoffMs({ nowMs: NOW, months: 12, newestTimesDesc: newest }), newest[199]);
  });
  it("keeps recent attempts even beyond the 200th", () => {
    const newest = times(200, 1); // 200th newest is 200 days old: younger than 12 months
    assert.equal(attemptCutoffMs({ nowMs: NOW, months: 12, newestTimesDesc: newest }), NOW - 12 * 30 * DAY);
  });
});

describe("keepNewestCutoffMs", () => {
  it("returns the Nth newest or null", () => {
    assert.equal(keepNewestCutoffMs([5, 4, 3], 3), 3);
    assert.equal(keepNewestCutoffMs([5, 4], 3), null);
  });
});

describe("chunk", () => {
  it("splits into batches of at most 400", () => {
    const parts = chunk(Array.from({ length: 1000 }, (_, i) => i));
    assert.deepEqual(parts.map((p) => p.length), [400, 400, 200]);
  });
});

function fakeDeps(total: number) {
  const state = { remaining: total, removeCalls: [] as Array<{ action: CleanupAction; limit: number }> };
  const deps: CleanupDeps = {
    async count() { return state.remaining; },
    async remove(action, _params, limit) { state.removeCalls.push({ action, limit }); const n = Math.min(limit, state.remaining); state.remaining -= n; return n; },
  };
  return { deps, state };
}

describe("cleanup orchestration", () => {
  it("preview counts and never removes", async () => {
    const { deps, state } = fakeDeps(30);
    assert.deepEqual(await previewCleanup(deps, "quiz_attempts", { months: 12 }), { count: 30 });
    assert.equal(state.removeCalls.length, 0);
  });
  it("deletes at most 400 per call and reports the remainder", async () => {
    const { deps, state } = fakeDeps(1000);
    assert.deepEqual(await runCleanup(deps, "learning_events", { months: 12 }), { deleted: DELETE_BATCH_SIZE, remaining: 600 });
    assert.equal(state.removeCalls[0].limit, 400);
  });
  it("thumbnails use the 50-per-call batch", async () => {
    const { deps, state } = fakeDeps(120);
    assert.deepEqual(await runCleanup(deps, "thumbnails", { months: 12 }), { deleted: THUMBNAIL_BATCH_SIZE, remaining: 70 });
  });
  it("does nothing when there is nothing to delete", async () => {
    const { deps, state } = fakeDeps(0);
    assert.deepEqual(await runCleanup(deps, "used_tokens", { months: 12 }), { deleted: 0, remaining: 0 });
    assert.equal(state.removeCalls.length, 0);
  });
  it("30 old attempts: only those 30 are removed", async () => {
    const { deps, state } = fakeDeps(30);
    assert.deepEqual(await runCleanup(deps, "quiz_attempts", { months: 12 }), { deleted: 30, remaining: 0 });
    assert.equal(state.remaining, 0);
  });
});
