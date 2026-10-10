import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cleanupLegacyDriveConnections, planLegacyCleanup, type CleanupRow, type CleanupStore } from "./legacyDriveCleanup";

const legacy = (id: string, data: Record<string, unknown> = {}): CleanupRow => ({ id, data });

describe("planLegacyCleanup", () => {
  it("deletes only old docs whose unified twin links back", () => {
    const plan = planLegacyCleanup(
      [legacy("a", { migratedTo: "g1" }), legacy("b", { migratedTo: "g2" }), legacy("c", {}), legacy("d", { migratedTo: "gone" })],
      [legacy("g1", { legacyDriveConnectionId: "a" }), legacy("g2", { legacyDriveConnectionId: "other" })],
    );
    assert.deepEqual(plan, { deletable: ["a"], blocked: 3 });
  });

  it("deletes nothing when there is no unified doc", () => {
    assert.deepEqual(planLegacyCleanup([legacy("a", { migratedTo: "g1" })], []), { deletable: [], blocked: 1 });
  });

  it("handles empty input", () => {
    assert.deepEqual(planLegacyCleanup([], []), { deletable: [], blocked: 0 });
  });
});

describe("cleanupLegacyDriveConnections", () => {
  it("deletes the safe ones, leaves the rest and never touches unified docs", async () => {
    const deleted: string[] = [];
    const store: CleanupStore = {
      async listLegacy() { return [legacy("a", { migratedTo: "g1" }), legacy("b", {})]; },
      async listGoogle() { return [legacy("g1", { legacyDriveConnectionId: "a" })]; },
      async deleteLegacy(_uid, id) { deleted.push(id); },
    };
    assert.deepEqual(await cleanupLegacyDriveConnections(store, "u"), { deleted: 1, blocked: 1 });
    assert.deepEqual(deleted, ["a"]);
    assert.deepEqual(Object.keys(store).sort(), ["deleteLegacy", "listGoogle", "listLegacy"]);
  });

  it("is idempotent", async () => {
    const legacyDocs = [legacy("a", { migratedTo: "g1" })];
    const store: CleanupStore = {
      async listLegacy() { return [...legacyDocs]; },
      async listGoogle() { return [legacy("g1", { legacyDriveConnectionId: "a" })]; },
      async deleteLegacy(_uid, id) { legacyDocs.splice(legacyDocs.findIndex((d) => d.id === id), 1); },
    };
    await cleanupLegacyDriveConnections(store, "u");
    assert.deepEqual(await cleanupLegacyDriveConnections(store, "u"), { deleted: 0, blocked: 0 });
  });
});
