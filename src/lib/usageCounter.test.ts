import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectionShape, createUsageCounter, readsForSnapshotSize } from "./usageCounter";

describe("usageCounter", () => {
  it("maps paths to id-free collection shapes", () => {
    assert.equal(collectionShape("users"), "users");
    assert.equal(collectionShape("users/uid1/personalDocuments"), "users/…/personalDocuments");
    assert.equal(collectionShape("users/uid1/personalDocuments/doc9"), "users/…/personalDocuments");
    assert.equal(collectionShape(""), "unknown");
  });

  it("bills an empty query as one read", () => {
    assert.equal(readsForSnapshotSize(0), 1);
    assert.equal(readsForSnapshotSize(12), 12);
  });

  it("counts per collection and resets", () => {
    const counter = createUsageCounter();
    counter.record("reads", "users/a/goals", 3);
    counter.record("writes", "users/a/goals/g1");
    counter.record("deletes", "users/b/goals/g2");
    assert.deepEqual(counter.snapshot()["users/…/goals"], { reads: 3, writes: 1, deletes: 1 });
    assert.deepEqual(counter.totals(), { reads: 3, writes: 1, deletes: 1 });
    counter.reset();
    assert.deepEqual(counter.snapshot(), {});
  });
});
