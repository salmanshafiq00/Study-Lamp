import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toBatches } from "./batches";

describe("toBatches", () => {
  it("splits migration work into calls of at most 5 items", () => {
    assert.deepEqual(toBatches([1, 2, 3, 4, 5, 6, 7], 5), [[1, 2, 3, 4, 5], [6, 7]]);
    assert.deepEqual(toBatches([], 5), []);
  });
});
