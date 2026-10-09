import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrateOneAnnotation, type AnnotationMigrationDeps } from "./annotationMigration";

const legacy = JSON.stringify([{ annotation: { type: 9, id: "a1", pageIndex: 0 } }]);

function deps(overrides: Partial<AnnotationMigrationDeps> = {}) {
  const state = { stored: null as string | null, legacyDeleted: false };
  const value: AnnotationMigrationDeps = {
    readLegacy: async () => legacy,
    putBlob: async (_id, text) => { state.stored = text; },
    readBackBlob: async () => state.stored,
    deleteLegacy: async () => { state.legacyDeleted = true; },
    ...overrides,
  };
  return { value, state };
}

describe("migrateOneAnnotation", () => {
  it("verifies by hash, then deletes the legacy copy", async () => {
    const { value, state } = deps();
    assert.notEqual(await migrateOneAnnotation(value, "doc1"), "failed");
    assert.equal(state.legacyDeleted, true);
  });
  it("never deletes the legacy copy when the read-back differs", async () => {
    const { value, state } = deps({ readBackBlob: async () => JSON.stringify({ version: 1, annotations: [{ other: 1 }] }) });
    assert.equal(await migrateOneAnnotation(value, "doc1"), "failed");
    assert.equal(state.legacyDeleted, false);
  });
  it("never deletes when the read-back is missing or the write throws", async () => {
    const missing = deps({ readBackBlob: async () => null });
    assert.equal(await migrateOneAnnotation(missing.value, "d"), "failed");
    assert.equal(missing.state.legacyDeleted, false);
    const broken = deps({ putBlob: async () => { throw new Error("drive down"); } });
    assert.equal(await migrateOneAnnotation(broken.value, "d"), "failed");
    assert.equal(broken.state.legacyDeleted, false);
  });
  it("skips documents without legacy annotations", async () => {
    assert.equal(await migrateOneAnnotation(deps({ readLegacy: async () => null }).value, "doc1"), "skipped_none");
  });
});
