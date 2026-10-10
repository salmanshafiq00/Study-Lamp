import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { migrateDriveConnections, pendingLegacyCount, type DocRow, type MigrationDeps } from "./driveMigration";

type Data = Record<string, unknown>;
const NOW = "NOW";

function fake(initialLegacy: DocRow[], initialGoogle: DocRow[], verifyResult: boolean | ((token: string, folder: string | null) => boolean) = true) {
  const legacy = new Map(initialLegacy.map((row) => [row.id, { ...row.data }]));
  const google = new Map(initialGoogle.map((row) => [row.id, { ...row.data }]));
  const writes: string[] = [];
  const verifyCalls: Array<{ token: string; folder: string | null }> = [];
  let counter = 0;
  const rows = (map: Map<string, Data>): DocRow[] => [...map.entries()].map(([id, data]) => ({ id, data: { ...data } }));
  const deps: MigrationDeps = {
    now: () => NOW,
    async verify(_uid, token, folder) {
      verifyCalls.push({ token, folder });
      return typeof verifyResult === "function" ? verifyResult(token, folder) : verifyResult;
    },
    store: {
      async listLegacy() { return rows(legacy); },
      async listGoogle() { return rows(google); },
      async createGoogle(_uid, data) { counter += 1; const id = `newGoogle${counter}`; google.set(id, data); writes.push(`create:${id}`); return id; },
      async updateGoogle(_uid, id, patch) { google.set(id, { ...google.get(id), ...patch }); writes.push(`updateGoogle:${id}`); },
      async updateLegacy(_uid, id, patch) { legacy.set(id, { ...legacy.get(id), ...patch }); writes.push(`updateLegacy:${id}`); },
    },
  };
  return { deps, legacy, google, writes, verifyCalls };
}

const LEGACY = (id: string, extra: Data = {}): DocRow => ({
  id,
  data: { googleEmail: "Student@Example.com", encryptedRefreshToken: `enc-${id}`, status: "active", createdAt: "created", lastUsedAt: null, ...extra },
});

describe("migrateDriveConnections", () => {
  it("creates a unified doc from the old token when none exists, copying the token and the app folder", async () => {
    const { deps, google, legacy, verifyCalls } = fake([LEGACY("old1", { appFolderId: "folder-1" })], []);
    const report = await migrateDriveConnections(deps, "u");
    assert.deepEqual(report.items, [{ legacyId: "old1", outcome: "migrated" }]);
    assert.equal(google.size, 1);
    const [newId, doc] = [...google.entries()][0];
    assert.equal(doc.encryptedRefreshToken, "enc-old1");
    assert.deepEqual(doc.grantedScopes, ["drive"]);
    assert.equal(doc.appFolderId, "folder-1");
    assert.equal(doc.legacyDriveConnectionId, "old1");
    assert.equal(legacy.get("old1")?.migratedTo, newId);
    assert.deepEqual(verifyCalls, [{ token: "enc-old1", folder: "folder-1" }]);
  });

  it("is idempotent: a second run writes nothing", async () => {
    const env = fake([LEGACY("old1")], []);
    await migrateDriveConnections(env.deps, "u");
    const before = env.writes.length;
    const second = await migrateDriveConnections(env.deps, "u");
    assert.equal(env.writes.length, before);
    assert.deepEqual(second.items, [{ legacyId: "old1", outcome: "already_migrated" }]);
    assert.equal(second.counts.already_migrated, 1);
  });

  it("refuses to mark anything done when verification fails, and writes nothing", async () => {
    const env = fake([LEGACY("old1")], [], false);
    const report = await migrateDriveConnections(env.deps, "u");
    assert.deepEqual(report.items, [{ legacyId: "old1", outcome: "verify_failed" }]);
    assert.deepEqual(env.writes, []);
    assert.equal(env.legacy.get("old1")?.migratedTo, undefined);
  });

  it("links to an existing unified doc that already has Drive, and keeps that doc's own token", async () => {
    const google: DocRow = { id: "g1", data: { googleEmail: "student@example.com", encryptedRefreshToken: "enc-google", grantedScopes: ["calendar", "drive"], status: "active" } };
    const env = fake([LEGACY("old1", { appFolderId: "folder-9" })], [google]);
    const report = await migrateDriveConnections(env.deps, "u");
    assert.equal(report.items[0].outcome, "migrated");
    const merged = env.google.get("g1")!;
    assert.equal(merged.encryptedRefreshToken, "enc-google"); // never overwritten
    assert.equal(merged.legacyDriveConnectionId, "old1");
    assert.equal(merged.appFolderId, "folder-9");
    assert.deepEqual(merged.grantedScopes, ["calendar", "drive"]);
    assert.equal(env.legacy.get("old1")?.migratedTo, "g1");
    assert.equal(env.verifyCalls[0].token, "enc-google");
  });

  it("matches accounts by e-mail ignoring case and spaces", async () => {
    const google: DocRow = { id: "g1", data: { googleEmail: "  student@EXAMPLE.com ", encryptedRefreshToken: "t", grantedScopes: ["drive"], status: "active" } };
    const env = fake([LEGACY("old1")], [google]);
    assert.equal((await migrateDriveConnections(env.deps, "u")).items[0].outcome, "migrated");
    assert.equal(env.google.size, 1);
  });

  it("reports needs_drive_consent (and writes nothing) when the unified doc has no Drive grant", async () => {
    const google: DocRow = { id: "g1", data: { googleEmail: "student@example.com", encryptedRefreshToken: "t", grantedScopes: ["calendar"], status: "active" } };
    const env = fake([LEGACY("old1")], [google]);
    const report = await migrateDriveConnections(env.deps, "u");
    assert.equal(report.items[0].outcome, "needs_drive_consent");
    assert.deepEqual(env.writes, []);
    assert.equal(env.verifyCalls.length, 0);
    assert.equal(env.google.get("g1")?.encryptedRefreshToken, "t"); // Calendar token untouched
  });

  it("skips an old connection that already needs reconnecting", async () => {
    const env = fake([LEGACY("old1", { status: "invalid" })], []);
    assert.equal((await migrateDriveConnections(env.deps, "u")).items[0].outcome, "skipped_invalid");
    assert.deepEqual(env.writes, []);
  });

  it("skips (without verifying) when the unified doc is flagged invalid", async () => {
    const google: DocRow = { id: "g1", data: { googleEmail: "student@example.com", encryptedRefreshToken: "t", grantedScopes: ["drive"], status: "invalid" } };
    const env = fake([LEGACY("old1")], [google]);
    assert.equal((await migrateDriveConnections(env.deps, "u")).items[0].outcome, "skipped_invalid");
    assert.deepEqual(env.writes, []);
  });

  it("recovers from a crash between linking the unified doc and marking the old one", async () => {
    const google: DocRow = { id: "g1", data: { googleEmail: "student@example.com", encryptedRefreshToken: "t", grantedScopes: ["drive"], status: "active", legacyDriveConnectionId: "old1" } };
    const env = fake([LEGACY("old1")], [google]);
    const report = await migrateDriveConnections(env.deps, "u");
    assert.equal(report.items[0].outcome, "migrated");
    assert.deepEqual(env.writes, ["updateLegacy:old1"]);
    assert.equal(env.verifyCalls.length, 0);
  });

  it("handles several accounts independently and counts outcomes", async () => {
    const env = fake(
      [LEGACY("a1", { googleEmail: "a@x.com" }), LEGACY("b1", { googleEmail: "b@x.com" }), LEGACY("c1", { googleEmail: "c@x.com", status: "invalid" })],
      [],
      (token) => token !== "enc-b1",
    );
    const report = await migrateDriveConnections(env.deps, "u");
    assert.deepEqual(report.counts, { migrated: 1, already_migrated: 0, needs_drive_consent: 0, skipped_invalid: 1, verify_failed: 1 });
    assert.equal(env.legacy.get("b1")?.migratedTo, undefined);
  });

  it("never writes outside the two doc stores: no delete operation exists on the store", () => {
    const { deps } = fake([], []);
    assert.deepEqual(Object.keys(deps.store).sort(), ["createGoogle", "listGoogle", "listLegacy", "updateGoogle", "updateLegacy"]);
  });

  it("fails safely (writes nothing) for an old doc without an e-mail or token", async () => {
    const env = fake([{ id: "bad", data: { status: "active" } }], []);
    assert.equal((await migrateDriveConnections(env.deps, "u")).items[0].outcome, "verify_failed");
    assert.deepEqual(env.writes, []);
  });
});

describe("pendingLegacyCount", () => {
  it("counts old docs that have no existing migration target", () => {
    const legacy: DocRow[] = [
      { id: "a", data: { migratedTo: "g1" } },
      { id: "b", data: {} },
      { id: "c", data: { migratedTo: "gone" } },
    ];
    assert.equal(pendingLegacyCount(legacy, [{ id: "g1", data: {} }]), 2);
    assert.equal(pendingLegacyCount([], []), 0);
  });
});
