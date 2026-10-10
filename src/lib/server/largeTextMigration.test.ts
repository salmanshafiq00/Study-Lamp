import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashText } from "@/lib/server/docTextCache";
import { isOversizedInline, migrateOneContent, migrateOneField } from "@/lib/server/largeTextMigration";

const big = "x".repeat(30_000);

function pick(actual: unknown, expected: unknown): unknown {
  if (!expected || typeof expected !== "object" || !actual || typeof actual !== "object") return actual;
  return Object.fromEntries(Object.keys(expected).map((k) => [k, (actual as Record<string, unknown>)[k]]));
}

describe("migrateOneField", () => {
  function deps(overrides: { back?: (written: string) => string | null } = {}) {
    let written = ""; let pointer: unknown = null;
    return {
      get written() { return written; }, get pointer() { return pointer; },
      d: {
        async readInline() { return big; },
        async putBlob(t: string) { written = t; },
        async readBack() { return overrides.back ? overrides.back(written) : written; },
        async writePointer(p: unknown) { pointer = p; },
      },
    };
  }
  it("moves and writes the pointer after a matching read-back", async () => {
    const f = deps();
    assert.equal(await migrateOneField(f.d, "note", "n1"), "moved");
    assert.deepEqual(pick(f.pointer, { blobKind: "note", blobKey: "n1", bytes: 30_000 }), { blobKind: "note", blobKey: "n1", bytes: 30_000 });
  });
  it("does NOT replace the Firestore copy when the read-back differs", async () => {
    const f = deps({ back: () => JSON.stringify({ text: "other" }) });
    assert.equal(await migrateOneField(f.d, "note", "n1"), "failed");
    assert.equal(f.pointer, null);
  });
  it("skips small values", async () => {
    const f = deps(); f.d.readInline = async () => "small";
    assert.equal(await migrateOneField(f.d, "summary", "s1"), "skipped");
  });
  it("detects oversized inline docs only", () => {
    assert.equal(isOversizedInline({ content: big }), true);
    assert.equal(isOversizedInline({ content: big, blobKind: "note" }), false);
    assert.equal(isOversizedInline({ content: "small" }), false);
  });
});

describe("migrateOneContent", () => {
  const legacy = { text: "doc text", revision: { md5Checksum: "a", modifiedTime: null }, textHash: hashText("doc text") };
  it("deletes legacy chunks only after the hash matched", async () => {
    let deleted = 0; let written = "";
    const status = await migrateOneContent({
      async readLegacyText() { return legacy; }, async putBlob(t) { written = t; },
      async readBack() { return written; }, async deleteLegacy() { deleted++; },
    });
    assert.equal(status, "moved"); assert.equal(deleted, 1);
  });
  it("refuses to delete on a hash mismatch", async () => {
    let deleted = 0;
    const status = await migrateOneContent({
      async readLegacyText() { return legacy; }, async putBlob() {},
      async readBack() { return JSON.stringify({ text: "different" }); }, async deleteLegacy() { deleted++; },
    });
    assert.equal(status, "failed"); assert.equal(deleted, 0);
  });
  it("leaves a corrupt legacy copy alone", async () => {
    let deleted = 0;
    const status = await migrateOneContent({
      async readLegacyText() { return { ...legacy, textHash: "bad" }; }, async putBlob() {},
      async readBack() { return null; }, async deleteLegacy() { deleted++; },
    });
    assert.equal(status, "failed"); assert.equal(deleted, 0);
  });
});
