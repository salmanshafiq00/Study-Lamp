import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLearningQueue } from "./learningDays";

describe("learning queue", () => {
  it("aggregates many events into one entry per day", () => {
    const queue = createLearningQueue();
    queue.addEvent("2026-10-09", "video_completed");
    queue.addEvent("2026-10-09", "video_completed");
    queue.addEvent("2026-10-09", "goal_completed");
    queue.addAmount("2026-10-09", "watchSeconds", 61.4);
    queue.addAmount("2026-10-10", "quizzes", 1);
    const drained = queue.drain();
    assert.equal(drained.length, 2);
    const first = drained.find((item) => item.day === "2026-10-09")!;
    assert.deepEqual(first.counts, { events: 3, watchSeconds: 61 });
    assert.deepEqual(first.byEvent, { video_completed: 2, goal_completed: 1 });
    assert.equal(queue.size(), 0);
  });

  it("rejects bad event names and non-positive amounts", () => {
    const queue = createLearningQueue();
    queue.addEvent("2026-10-09", "Bad Name!");
    queue.addAmount("2026-10-09", "docMinutes", -3);
    queue.addAmount("2026-10-09", "docMinutes", Number.NaN);
    assert.equal(queue.size(), 0);
  });

  it("restore merges a failed batch back without loss", () => {
    const queue = createLearningQueue();
    queue.addEvent("2026-10-09", "tour_started");
    const failed = queue.drain();
    queue.addEvent("2026-10-09", "tour_started");
    queue.restore(failed);
    const [merged] = queue.drain();
    assert.deepEqual(merged.byEvent, { tour_started: 2 });
    assert.equal(merged.counts.events, 2);
  });
});
