import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readStoredTextServer } from "@/lib/server/largeTextServer";
import { BLOB_KINDS, BLOB_NAME_PATTERN, assertBlobWriteAllowed, BlobStoreError } from "@/lib/server/driveBlobStore";

describe("readStoredTextServer", () => {
  it("returns inline content without a Drive call", async () => {
    const reader = { async get() { throw new Error("must not be called"); } };
    assert.equal(await readStoredTextServer(reader, "u", { content: "inline" }), "inline");
  });
  it("reads the blob for a pointer", async () => {
    const reader = { async get() { return { json: { text: "full" } }; } };
    assert.equal(await readStoredTextServer(reader, "u", { content: "pre", blobKind: "summary", blobKey: "d_abc" }), "full");
  });
  it("throws instead of returning the preview when the blob is gone", async () => {
    const reader = { async get() { return null; } };
    await assert.rejects(readStoredTextServer(reader, "u", { content: "pre", blobKind: "note", blobKey: "d_abc" }));
  });
});

describe("blob allowlist after P5", () => {
  it("includes summary and note, and the name pattern accepts them", () => {
    assert.ok(BLOB_KINDS.includes("summary")); assert.ok(BLOB_KINDS.includes("note"));
    assert.equal(BLOB_NAME_PATTERN.test("summary-d_abc123.json"), true);
    assert.equal(BLOB_NAME_PATTERN.test("other-d_abc123.json"), false);
  });
  it("still rejects a foreign parent folder", () => {
    assert.throws(() => assertBlobWriteAllowed({ parentId: "x", folderId: "y", name: "note-a.json", bytes: 1, kind: "note" }), BlobStoreError);
  });
});
