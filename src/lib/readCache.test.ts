import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { cachedRead, clearReadCache, invalidate } from "./readCache";

describe("readCache", () => {
  beforeEach(() => clearReadCache());

  it("returns the cached value until it expires (fake clock)", async () => {
    let time = 1000; let calls = 0;
    const load = async () => ++calls;
    assert.equal(await cachedRead("k", 500, load, () => time), 1);
    time = 1400;
    assert.equal(await cachedRead("k", 500, load, () => time), 1);
    time = 1501;
    assert.equal(await cachedRead("k", 500, load, () => time), 2);
  });

  it("shares one in-flight loader between concurrent callers", async () => {
    let calls = 0;
    const load = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 5)); return "v"; };
    const [a, b] = await Promise.all([cachedRead("k", 1000, load), cachedRead("k", 1000, load)]);
    assert.deepEqual([a, b, calls], ["v", "v", 1]);
  });

  it("invalidates by prefix only", async () => {
    let calls = 0;
    const load = async () => ++calls;
    await cachedRead("states:u1", 1000, load);
    await cachedRead("tags", 1000, load);
    invalidate("states:");
    assert.equal(await cachedRead("states:u1", 1000, load), 3);
    assert.equal(await cachedRead("tags", 1000, load), 2);
  });

  it("does not cache a loader error", async () => {
    let calls = 0;
    const load = async () => { calls++; if (calls === 1) throw new Error("boom"); return "ok"; };
    await assert.rejects(cachedRead("k", 1000, load));
    assert.equal(await cachedRead("k", 1000, load), "ok");
  });
});
