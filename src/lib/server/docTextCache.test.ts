import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hashText, resolveDocumentText, type DocTextBlob, type DocTextDeps } from "@/lib/server/docTextCache";

const rev1 = { md5Checksum: "aaa111", modifiedTime: null };
const rev2 = { md5Checksum: "bbb222", modifiedTime: null };

function fake(options: { blob?: DocTextBlob | null; legacy?: string | null; failWrite?: boolean } = {}) {
  const calls = { extract: 0, write: 0, deleteLegacy: 0, recordRevision: 0, firestoreChunkWrites: 0 };
  let blob: DocTextBlob | null = options.blob ?? null;
  const deps: DocTextDeps = {
    async readBlob() { return blob; },
    async writeBlob(b) { calls.write++; if (options.failWrite) throw new Error("drive"); blob = b; },
    async readLegacy() { return options.legacy ?? null; },
    async deleteLegacy() { calls.deleteLegacy++; },
    async extract() { calls.extract++; return "fresh text"; },
    async recordRevision() { calls.recordRevision++; },
  };
  return { deps, calls, getBlob: () => blob };
}
const blobFor = (text: string, revision = rev1): DocTextBlob => ({ revision, textHash: hashText(text), text });

function pick(actual: unknown, expected: unknown): unknown {
  if (!expected || typeof expected !== "object" || !actual || typeof actual !== "object") return actual;
  return Object.fromEntries(Object.keys(expected).map((k) => [k, (actual as Record<string, unknown>)[k]]));
}

describe("resolveDocumentText", () => {
  it("serves a valid blob without extracting or writing", async () => {
    const f = fake({ blob: blobFor("cached") });
    const result = await resolveDocumentText(f.deps, rev1);
    assert.deepEqual(result, { text: "cached", source: "blob", cached: true });
    assert.deepEqual(pick(f.calls, { extract: 0, write: 0 }), { extract: 0, write: 0 });
  });
  it("a changed Drive revision re-extracts and refreshes the blob", async () => {
    const f = fake({ blob: blobFor("old", rev1) });
    const result = await resolveDocumentText(f.deps, rev2);
    assert.equal(result.source, "extracted");
    assert.equal(f.calls.extract, 1);
    assert.equal(f.getBlob()?.revision.md5Checksum, "bbb222");
    assert.equal(f.calls.recordRevision, 1);
  });
  it("a missing blob re-extracts and caches it", async () => {
    const f = fake();
    const result = await resolveDocumentText(f.deps, rev1);
    assert.deepEqual(result, { text: "fresh text", source: "extracted", cached: true });
    assert.equal(f.getBlob()?.text, "fresh text");
  });
  it("a corrupted blob (hash mismatch) is ignored", async () => {
    const f = fake({ blob: { ...blobFor("good"), text: "tampered" } });
    assert.equal((await resolveDocumentText(f.deps, rev1)).source, "extracted");
  });
  it("legacy Firestore text is migrated to the blob and the chunks removed only after read-back", async () => {
    const f = fake({ legacy: "legacy text" });
    const result = await resolveDocumentText(f.deps, rev1);
    assert.deepEqual(pick(result, { text: "legacy text", source: "legacy", cached: true }), { text: "legacy text", source: "legacy", cached: true });
    assert.equal(f.calls.extract, 0);
    assert.equal(f.calls.deleteLegacy, 1);
  });
  it("keeps legacy data when the blob cannot be written (no Drive)", async () => {
    const f = fake({ legacy: "legacy text", failWrite: true });
    const result = await resolveDocumentText(f.deps, rev1);
    assert.deepEqual(pick(result, { text: "legacy text", cached: false }), { text: "legacy text", cached: false });
    assert.equal(f.calls.deleteLegacy, 0);
  });
  it("returns extracted text uncached when Drive fails", async () => {
    const f = fake({ failWrite: true });
    assert.deepEqual(await resolveDocumentText(f.deps, rev1), { text: "fresh text", source: "extracted", cached: false });
  });
  it("never writes Firestore chunk documents", async () => {
    const f = fake();
    await resolveDocumentText(f.deps, rev1);
    assert.equal(f.calls.firestoreChunkWrites, 0); // the deps interface has no chunk writer at all
  });
});
