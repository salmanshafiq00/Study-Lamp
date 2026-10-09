import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  BlobStoreError, assertBlobWriteAllowed, blobFileName, deleteBlob, ensureAppFolder, getBlob, putBlob,
  type BlobPointer, type BlobPointerStore, type BlobStoreDeps, type DriveBlobApi,
} from "./driveBlobStore";

const FOLDER = "1FolderIdAbCdEfGhIjKlMnOp";

function fakes() {
  const files = new Map<string, { name: string; parent: string; text: string; trashed: boolean; version: number }>();
  const folders = new Map<string, { trashed: boolean }>();
  const log: string[] = [];
  let counter = 0;
  const api: DriveBlobApi = {
    async getFolder(id) { const f = folders.get(id); return f ? { id, trashed: f.trashed } : null; },
    async findFolder() { log.push("findFolder"); for (const [id, f] of folders) if (!f.trashed) return id; return null; },
    async createFolder() { log.push("createFolder"); const id = `${FOLDER}${++counter}`; folders.set(id, { trashed: false }); return id; },
    async createFile({ name, parentId, json }) { log.push("createFile"); const id = `1FileId${String(++counter).padStart(12, "0")}`; files.set(id, { name, parent: parentId, text: json, trashed: false, version: 1 }); return { id, version: "1" }; },
    async updateFile(id, json) { log.push("updateFile"); const f = files.get(id); if (!f) return null; f.text = json; f.version++; return { id, version: String(f.version), trashed: f.trashed }; },
    async getFileMeta(id) { const f = files.get(id); return f ? { trashed: f.trashed, version: String(f.version) } : null; },
    async getFileContent(id) { const f = files.get(id); return f ? f.text : null; },
    async trashFile(id) { log.push("trashFile"); const f = files.get(id); if (f) f.trashed = true; },
  };
  const pointerMap = new Map<string, BlobPointer>();
  let folderId: string | null = null;
  const pointers: BlobPointerStore = {
    async getFolderId() { return folderId; },
    async setFolderId(_u, _c, id) { folderId = id; },
    async getPointer(_u, kind, key) { return pointerMap.get(`${kind}__${key}`) ?? null; },
    async setPointer(_u, kind, key, p) { pointerMap.set(`${kind}__${key}`, p); },
    async deletePointer(_u, kind, key) { pointerMap.delete(`${kind}__${key}`); },
  };
  const deps: BlobStoreDeps = { api, pointers, now: () => 1234 };
  return { deps, files, folders, pointerMap, log };
}

const base = { uid: "u1", connectionId: "c1", kind: "annotations" as const, key: "docABC123" };

describe("assertBlobWriteAllowed (D15 gate)", () => {
  const ok = { parentId: FOLDER, folderId: FOLDER, name: "annotations-doc1.json", bytes: 10, kind: "annotations" as const };
  it("accepts the stored folder with an allowlisted name", () => assert.doesNotThrow(() => assertBlobWriteAllowed(ok)));
  it("rejects another parent folder", () => assert.throws(() => assertBlobWriteAllowed({ ...ok, parentId: "1OtherFolderxxxxxxxxxx" }), { code: "forbidden" }));
  it("rejects names outside the pattern or with the wrong kind prefix", () => {
    for (const name of ["notes-doc1.json", "annotations-doc1.txt", "annotations-../x.json", "annotations-.json", "doctext-doc1.json"]) {
      assert.throws(() => assertBlobWriteAllowed({ ...ok, name }), { code: "forbidden" }, name);
    }
  });
  it("enforces size caps (2 MB annotations, 5 MB others)", () => {
    assert.throws(() => assertBlobWriteAllowed({ ...ok, bytes: 2 * 1024 * 1024 + 1 }), { code: "too_large" });
    assert.doesNotThrow(() => assertBlobWriteAllowed({ ...ok, kind: "doctext", name: "doctext-d.json", bytes: 3 * 1024 * 1024 }));
  });
});

describe("blob store", () => {
  it("creates the folder once, creates a file, and round-trips through the pointer", async () => {
    const f = fakes();
    const saved = await putBlob(f.deps, { ...base, jsonText: JSON.stringify({ a: 1 }) });
    assert.equal(saved.bytes, 7);
    assert.deepEqual(f.log.filter((x) => x.endsWith("Folder")), ["findFolder", "createFolder"]);
    const [[, file]] = [...f.files.entries()];
    assert.equal(file.name, blobFileName("annotations", base.key));
    assert.equal(f.pointerMap.get(`annotations__${base.key}`)?.connectionId, "c1");
    const read = await getBlob(f.deps, { uid: "u1", kind: "annotations", key: base.key });
    assert.deepEqual(read?.json, { a: 1 });
  });

  it("updates in place on the second save", async () => {
    const f = fakes();
    await putBlob(f.deps, { ...base, jsonText: "{\"v\":1}" });
    await putBlob(f.deps, { ...base, jsonText: "{\"v\":2}" });
    assert.equal(f.files.size, 1);
    assert.equal(f.log.filter((x) => x === "createFile").length, 1);
    assert.deepEqual((await getBlob(f.deps, { uid: "u1", kind: "annotations", key: base.key }))?.json, { v: 2 });
  });

  it("a file trashed in Drive reads as empty and the next save recreates it", async () => {
    const f = fakes();
    await putBlob(f.deps, { ...base, jsonText: "{\"v\":1}" });
    for (const file of f.files.values()) file.trashed = true;
    assert.equal(await getBlob(f.deps, { uid: "u1", kind: "annotations", key: base.key }), null);
    assert.equal(f.pointerMap.size, 0);
    await putBlob(f.deps, { ...base, jsonText: "{\"v\":2}" });
    assert.equal(f.log.filter((x) => x === "createFile").length, 2);
  });

  it("a save over a trashed pointer file creates a new file instead of writing to the trash", async () => {
    const f = fakes();
    await putBlob(f.deps, { ...base, jsonText: "{\"v\":1}" });
    for (const file of f.files.values()) file.trashed = true;
    await putBlob(f.deps, { ...base, jsonText: "{\"v\":2}" });
    assert.equal(f.files.size, 2);
    assert.deepEqual((await getBlob(f.deps, { uid: "u1", kind: "annotations", key: base.key }))?.json, { v: 2 });
  });

  it("treats invalid JSON edited in Drive as empty", async () => {
    const f = fakes();
    await putBlob(f.deps, { ...base, jsonText: "{}" });
    for (const file of f.files.values()) file.text = "not json";
    assert.equal(await getBlob(f.deps, { uid: "u1", kind: "annotations", key: base.key }), null);
  });

  it("recreates the app folder when the stored one is trashed", async () => {
    const f = fakes();
    const first = await ensureAppFolder(f.deps, "u1", "c1");
    f.folders.get(first)!.trashed = true;
    const second = await ensureAppFolder(f.deps, "u1", "c1");
    assert.notEqual(first, second);
  });

  it("rejects bad kinds, keys and oversize payloads before any Drive call", async () => {
    const f = fakes();
    await assert.rejects(putBlob(f.deps, { ...base, key: "../evil", jsonText: "{}" }), { code: "invalid" });
    await assert.rejects(putBlob(f.deps, { ...base, kind: "other" as never, jsonText: "{}" }), { code: "invalid" });
    await assert.rejects(putBlob(f.deps, { ...base, jsonText: "x".repeat(2 * 1024 * 1024 + 1) }), { code: "too_large" });
    assert.deepEqual(f.log, []);
  });

  it("delete trashes (never hard-deletes) and removes the pointer", async () => {
    const f = fakes();
    await putBlob(f.deps, { ...base, jsonText: "{}" });
    assert.equal(await deleteBlob(f.deps, { uid: "u1", kind: "annotations", key: base.key }), true);
    assert.equal([...f.files.values()][0].trashed, true);
    assert.equal(f.pointerMap.size, 0);
    assert.equal(await deleteBlob(f.deps, { uid: "u1", kind: "annotations", key: base.key }), false);
  });

  it("errors carry a code and no provider text", () => {
    const error = new BlobStoreError("auth", 401);
    assert.equal(error.status, 401);
    assert.equal(error.message, "blob store: auth");
  });
});
