import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPersister } from "./persistThrottle";

function harness<T>(overrides: { fail?: () => boolean; isSignificant?: (a: T, b: T) => boolean; initial?: T } = {}) {
  let time = 0;
  const timers: Array<{ at: number; callback: () => void; id: number; active: boolean }> = [];
  const written: T[] = [];
  const persister = createPersister<T>({
    minIntervalMs: 60_000,
    initial: overrides.initial,
    isSignificant: overrides.isSignificant,
    now: () => time,
    setTimer: (callback, ms) => { const timer = { at: time + ms, callback, id: timers.length, active: true }; timers.push(timer); return timer.id; },
    clearTimer: (id) => { const timer = timers[id as number]; if (timer) timer.active = false; },
    write: async (value) => { if (overrides.fail?.()) throw new Error("x"); written.push(value); },
  });
  const advance = async (ms: number) => {
    time += ms;
    for (const timer of timers) if (timer.active && timer.at <= time) { timer.active = false; timer.callback(); }
    await new Promise((resolve) => setImmediate(resolve));
  };
  return { persister, written, advance, setTime: (value: number) => { time = value; } };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("createPersister", () => {
  it("writes the first value at once, then at most once per interval", async () => {
    const { persister, written, advance } = harness<number>();
    persister.update(1); await tick();
    persister.update(2); persister.update(3); await tick();
    assert.deepEqual(written, [1]);
    await advance(60_000);
    assert.deepEqual(written, [1, 3]);
  });

  it("skips unchanged values", async () => {
    const { persister, written, advance } = harness<number>({ initial: 5 });
    persister.update(5); await advance(120_000);
    assert.deepEqual(written, []);
  });

  it("ignores changes below the significance threshold until flush", async () => {
    const { persister, written, advance } = harness<number>({ initial: 100, isSignificant: (a, b) => Math.abs(a - b) >= 10 });
    persister.update(103); await advance(120_000);
    assert.deepEqual(written, []);
    assert.equal(await persister.flush(), true);
    assert.deepEqual(written, [103]);
  });

  it("flush writes the pending value immediately and only once", async () => {
    const { persister, written } = harness<string>();
    persister.update("a"); await tick();
    persister.update("b");
    await persister.flush();
    await persister.flush();
    assert.deepEqual(written, ["a", "b"]);
  });

  it("keeps the pending value after a write error and retries", async () => {
    let failing = true;
    const { persister, written, advance } = harness<number>({ fail: () => failing });
    persister.update(1); await tick();
    assert.equal(persister.hasPending(), true);
    failing = false;
    await advance(60_000);
    assert.deepEqual(written, [1]);
    assert.equal(persister.hasPending(), false);
  });

  it("uses the retry delay function after failures", async () => {
    let time = 0; let failing = true; const delays: number[] = []; const written: number[] = [];
    const persister = createPersister<number>({
      minIntervalMs: 1000, now: () => time,
      retryDelayMs: (failures) => { const delay = 1000 * 2 ** failures; delays.push(delay); return delay; },
      setTimer: () => 0, clearTimer: () => {},
      write: async (value) => { if (failing) throw new Error("x"); written.push(value); },
    });
    persister.update(1); await tick();
    assert.equal(await persister.flush(), false);
    assert.deepEqual(delays, [2000, 4000]);
    failing = false; time = 10;
    assert.equal(await persister.flush(), true);
    assert.deepEqual(written, [1]);
  });

  it("a 5-minute session costs at most 6 writes", async () => {
    const { persister, written, advance } = harness<number>();
    for (let second = 1; second <= 300; second++) { persister.update(second); await advance(1000); }
    assert.ok(written.length <= 6, `wrote ${written.length}`);
  });
});
