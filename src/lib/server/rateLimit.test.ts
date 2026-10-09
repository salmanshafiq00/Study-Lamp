import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RATE_LIMITS, checkRateLimit } from "./rateLimit";

describe("checkRateLimit", () => {
  it("limits requests by uid and scope within a sliding window", () => {
    const options = { scope: "test-window-a", limit: 2, windowMs: 1000, now: 10_000 };
    assert.equal(checkRateLimit("uid-a", options), true);
    assert.equal(checkRateLimit("uid-a", options), true);
    assert.equal(checkRateLimit("uid-a", options), false);
    assert.equal(checkRateLimit("uid-b", options), true);
    assert.equal(checkRateLimit("uid-a", { ...options, now: 11_001 }), true);
  });

  it("defaults to 60 requests per minute", () => {
    const options = { scope: "test-default-b", now: 20_000 };
    for (let index = 0; index < 60; index++) assert.equal(checkRateLimit("uid", options), true);
    assert.equal(checkRateLimit("uid", options), false);
  });

  it("exposes the documented presets", () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(RATE_LIMITS).map(([name, value]) => [name, value.limit])),
      { default: 60, authSensitive: 10, stream: 1200, thumbnail: 600, sign: 180, import: 30, googleSync: 30, googleApply: 20, blob: 60 },
    );
  });

  it("applies a preset's limit per scope and uid", () => {
    const options = { scope: "test-preset-c", preset: "authSensitive" as const, now: 30_000 };
    for (let index = 0; index < RATE_LIMITS.authSensitive.limit; index++) assert.equal(checkRateLimit("uid", options), true);
    assert.equal(checkRateLimit("uid", options), false);
    assert.equal(checkRateLimit("other-uid", options), true);
  });

  it("lets a high-volume preset absorb a burst the default would reject", () => {
    const thumbnail = { scope: "test-preset-d", preset: "thumbnail" as const, now: 40_000 };
    for (let index = 0; index < 100; index++) assert.equal(checkRateLimit("uid", thumbnail), true);
    const fallback = { scope: "test-preset-e", now: 40_000 };
    for (let index = 0; index < 60; index++) assert.equal(checkRateLimit("uid", fallback), true);
    assert.equal(checkRateLimit("uid", fallback), false);
  });

  it("prefers an explicit limit over a preset", () => {
    const options = { scope: "test-preset-f", preset: "stream" as const, limit: 2, now: 50_000 };
    assert.equal(checkRateLimit("uid", options), true);
    assert.equal(checkRateLimit("uid", options), true);
    assert.equal(checkRateLimit("uid", options), false);
  });
});