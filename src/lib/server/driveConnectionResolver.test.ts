import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  googleDocHasDrive,
  planDriveDisconnect,
  resolveDriveConnection,
  selectDriveListing,
  type DocSnapLike,
  type ResolverStore,
} from "./driveConnectionResolver";

type Data = Record<string, unknown>;
const snap = (id: string, data?: Data): DocSnapLike => ({ id, exists: data !== undefined, data: () => data });

function fakeStore(google: Record<string, Data>, legacy: Record<string, Data>) {
  const calls: string[] = [];
  const store: ResolverStore = {
    async getGoogle(_uid, id) { calls.push(`google:${id}`); return snap(id, google[id]); },
    async getLegacy(_uid, id) { calls.push(`legacy:${id}`); return snap(id, legacy[id]); },
    async findGoogleByLegacyId(_uid, legacyId) {
      calls.push(`find:${legacyId}`);
      const hit = Object.entries(google).find(([, data]) => data.legacyDriveConnectionId === legacyId);
      return hit ? snap(hit[0], hit[1]) : null;
    },
  };
  return { store, calls };
}

const LEGACY_ID = "legacyConn1234567890";
const GOOGLE_ID = "googleConn1234567890";

describe("resolveDriveConnection", () => {
  it("resolves a unified id directly", async () => {
    const { store } = fakeStore({ [GOOGLE_ID]: { grantedScopes: ["drive", "calendar"] } }, {});
    assert.deepEqual(await resolveDriveConnection(store, "u", GOOGLE_ID), { kind: "google", id: GOOGLE_ID, legacyId: null, hasDrive: true });
  });

  it("reports hasDrive=false for a unified doc without Drive", async () => {
    const { store } = fakeStore({ [GOOGLE_ID]: { grantedScopes: ["calendar"] } }, {});
    const resolved = await resolveDriveConnection(store, "u", GOOGLE_ID);
    assert.equal(resolved?.kind === "google" && resolved.hasDrive, false);
  });

  it("resolves an un-migrated legacy id to the legacy doc", async () => {
    const { store } = fakeStore({}, { [LEGACY_ID]: { googleEmail: "a@b.c" } });
    assert.deepEqual(await resolveDriveConnection(store, "u", LEGACY_ID), { kind: "legacy", id: LEGACY_ID });
  });

  it("resolves a migrated legacy id to the unified doc (documents keep their old id)", async () => {
    const { store } = fakeStore(
      { [GOOGLE_ID]: { grantedScopes: ["drive"], legacyDriveConnectionId: LEGACY_ID } },
      { [LEGACY_ID]: { migratedTo: GOOGLE_ID } },
    );
    assert.deepEqual(await resolveDriveConnection(store, "u", LEGACY_ID), { kind: "google", id: GOOGLE_ID, legacyId: LEGACY_ID, hasDrive: true });
  });

  it("does not fall back to the old token when Drive was switched off on the unified doc", async () => {
    const { store } = fakeStore(
      { [GOOGLE_ID]: { grantedScopes: ["calendar"], legacyDriveConnectionId: LEGACY_ID } },
      { [LEGACY_ID]: { migratedTo: GOOGLE_ID } },
    );
    const resolved = await resolveDriveConnection(store, "u", LEGACY_ID);
    assert.equal(resolved?.kind, "google");
    assert.equal(resolved?.kind === "google" && resolved.hasDrive, false);
  });

  it("falls back to the legacy doc when the migration target is gone", async () => {
    const { store } = fakeStore({}, { [LEGACY_ID]: { migratedTo: GOOGLE_ID } });
    assert.deepEqual(await resolveDriveConnection(store, "u", LEGACY_ID), { kind: "legacy", id: LEGACY_ID });
  });

  it("finds the unified doc by link after the legacy doc was cleaned up", async () => {
    const { store } = fakeStore({ [GOOGLE_ID]: { grantedScopes: ["drive"], legacyDriveConnectionId: LEGACY_ID } }, {});
    assert.deepEqual(await resolveDriveConnection(store, "u", LEGACY_ID), { kind: "google", id: GOOGLE_ID, legacyId: LEGACY_ID, hasDrive: true });
  });

  it("returns null for an unknown id and rejects implausible ids before any lookup", async () => {
    const { store, calls } = fakeStore({}, {});
    assert.equal(await resolveDriveConnection(store, "u", "missingConn123456"), null);
    for (const bad of ["", "a/b", "x".repeat(201)]) assert.equal(await resolveDriveConnection(store, "u", bad), null);
    assert.equal(calls.filter((call) => call.includes("a/b")).length, 0);
  });

  it("does the cheap lookups first: a unified id costs one read", async () => {
    const { store, calls } = fakeStore({ [GOOGLE_ID]: { grantedScopes: ["drive"] } }, {});
    await resolveDriveConnection(store, "u", GOOGLE_ID);
    assert.deepEqual(calls, [`google:${GOOGLE_ID}`]);
  });
});

describe("selectDriveListing", () => {
  it("lists an un-migrated legacy doc under its own id", () => {
    const list = selectDriveListing([{ id: LEGACY_ID, data: { googleEmail: "a@b.c" } }], []);
    assert.deepEqual(list.map((item) => [item.id, item.source]), [[LEGACY_ID, "legacy"]]);
  });

  it("lists a migrated pair once, under the legacy id existing documents store", () => {
    const list = selectDriveListing(
      [{ id: LEGACY_ID, data: { migratedTo: GOOGLE_ID } }],
      [{ id: GOOGLE_ID, data: { grantedScopes: ["drive", "tasks"], legacyDriveConnectionId: LEGACY_ID } }],
    );
    assert.deepEqual(list.map((item) => [item.id, item.source]), [[LEGACY_ID, "google"]]);
  });

  it("lists a Drive-enabled unified doc without a legacy twin under its google id", () => {
    const list = selectDriveListing([], [{ id: GOOGLE_ID, data: { grantedScopes: ["drive"] } }]);
    assert.deepEqual(list.map((item) => item.id), [GOOGLE_ID]);
  });

  it("hides unified docs without Drive, and hides a migrated legacy doc whose Drive was switched off", () => {
    const list = selectDriveListing(
      [{ id: LEGACY_ID, data: { migratedTo: GOOGLE_ID } }],
      [{ id: GOOGLE_ID, data: { grantedScopes: ["calendar"], legacyDriveConnectionId: LEGACY_ID } }, { id: "calOnly1234567890", data: { grantedScopes: ["tasks"] } }],
    );
    assert.deepEqual(list, []);
  });

  it("keeps a legacy doc whose migration target no longer exists", () => {
    const list = selectDriveListing([{ id: LEGACY_ID, data: { migratedTo: GOOGLE_ID } }], []);
    assert.deepEqual(list.map((item) => item.id), [LEGACY_ID]);
  });
});

describe("planDriveDisconnect", () => {
  it("deletes a legacy doc", () => {
    assert.deepEqual(planDriveDisconnect({ kind: "legacy", id: LEGACY_ID }), { kind: "delete_legacy", legacyId: LEGACY_ID });
  });

  it("deletes a unified doc that exists only for Drive", () => {
    const action = planDriveDisconnect({ kind: "google", id: GOOGLE_ID, legacyId: LEGACY_ID, hasDrive: true }, { grantedScopes: ["drive"] });
    assert.deepEqual(action, { kind: "delete_google", googleId: GOOGLE_ID, legacyId: LEGACY_ID });
  });

  it("only switches Drive off when Calendar or Tasks still use the connection", () => {
    for (const scopes of [["drive", "calendar"], ["drive", "tasks"]]) {
      const action = planDriveDisconnect({ kind: "google", id: GOOGLE_ID, legacyId: null, hasDrive: true }, { grantedScopes: scopes });
      assert.deepEqual(action, { kind: "drop_drive_feature", googleId: GOOGLE_ID, legacyId: null });
    }
  });
});

describe("googleDocHasDrive", () => {
  it("is strict about the array and the value", () => {
    assert.equal(googleDocHasDrive({ grantedScopes: ["drive"] }), true);
    assert.equal(googleDocHasDrive({ grantedScopes: ["drive.file"] }), false);
    assert.equal(googleDocHasDrive({ grantedScopes: "drive" }), false);
    assert.equal(googleDocHasDrive(undefined), false);
  });
});
