import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBlobClient, createMemoryBlobStore, type RemoteResponse } from "./blobClient";

function setup(handler: (method: string, body?: string) => RemoteResponse | Promise<RemoteResponse>) {
  const local = createMemoryBlobStore();
  const calls: Array<{ method: string; body?: string }> = [];
  let time = 1_000_000;
  const client = createBlobClient({
    uid: "u1", local, now: () => time, writeIntervalMs: 1, staleAfterMs: 600_000,
    request: async (method, _kind, _key, body) => { calls.push({ method, body }); return handler(method, body); },
  });
  return { client, local, calls, advance: (ms: number) => { time += ms; } };
}

describe("blob client", () => {
  it("reads from Drive once, then instantly from IndexedDB", async () => {
    const { client, calls } = setup(() => ({ status: 200, body: { json: { annotations: [1] }, version: "7" } }));
    const first = await client.readThrough("annotations", "doc1");
    assert.deepEqual([first.source, first.json], ["remote", { annotations: [1] }]);
    const second = await client.readThrough("annotations", "doc1");
    assert.equal(second.source, "local");
    assert.equal(calls.length, 1);
  });

  it("clearing browser data makes the next read come from Drive again", async () => {
    const { client, calls } = setup(() => ({ status: 200, body: { json: { a: 1 }, version: "1" } }));
    await client.readThrough("annotations", "doc1");
    await client.clearLocal();
    assert.equal((await client.readThrough("annotations", "doc1")).source, "remote");
    assert.equal(calls.length, 2);
  });

  it("404 reads as none; other failures read as error with a code", async () => {
    assert.equal((await setup(() => ({ status: 404, body: {} })).client.readThrough("annotations", "d")).source, "none");
    const err = await setup(() => ({ status: 409, body: { code: "reconnect" } })).client.readThrough("annotations", "d");
    assert.deepEqual(err, { source: "error", json: null, code: "reconnect" });
  });

  it("write saves locally at once, then PUTs and marks the copy clean", async () => {
    const { client, local, calls } = setup(() => ({ status: 200, body: { ok: true, version: "9" } }));
    await client.write("annotations", "doc1", { annotations: [2] });
    assert.ok(["saving", "saved"].includes(client.getStatus("annotations", "doc1").state));
    await client.flush("annotations", "doc1");
    const record = await local.get(client.idOf("annotations", "doc1"));
    assert.deepEqual([record?.dirty, record?.version, client.getStatus("annotations", "doc1").state], [false, "9", "saved"]);
    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
  });

  it("keeps the local copy and reports offline when the network fails, then retries", async () => {
    let online = false;
    const { client, local } = setup(() => { if (!online) throw new Error("offline"); return { status: 200, body: { version: "2" } }; });
    await client.write("annotations", "doc1", { v: 1 });
    await client.flush("annotations", "doc1");
    assert.equal(client.getStatus("annotations", "doc1").state, "offline");
    assert.equal((await local.get(client.idOf("annotations", "doc1")))?.dirty, true);
    online = true;
    assert.equal(await client.flush("annotations", "doc1"), true);
    assert.equal(client.getStatus("annotations", "doc1").state, "saved");
  });

  it("uses the fallback for a final failure such as reconnect", async () => {
    const { client } = setup(() => ({ status: 409, body: { code: "reconnect" } }));
    const saved: unknown[] = [];
    await client.write("annotations", "doc1", { v: 1 }, async (json) => { saved.push(json); return true; });
    await client.flush("annotations", "doc1");
    assert.deepEqual(saved, [{ v: 1 }]);
    assert.equal(client.getStatus("annotations", "doc1").state, "saved");
  });

  it("without a working fallback the status is offline with the code and no retry storm", async () => {
    const { client, calls } = setup(() => ({ status: 413, body: { code: "too_large" } }));
    await client.write("annotations", "doc1", { v: 1 });
    await client.flush("annotations", "doc1");
    await client.flush("annotations", "doc1");
    assert.deepEqual(client.getStatus("annotations", "doc1"), { state: "offline", code: "too_large" });
    assert.equal(calls.length, 1);
  });

  it("a stale clean local copy is refreshed in the background and reported", async () => {
    const { client, advance } = setup(() => ({ status: 200, body: { json: { v: 2 }, version: "3" } }));
    await client.seedLocal("annotations", "doc1", { v: 1 });
    advance(11 * 60_000);
    const updates: unknown[] = [];
    const result = await client.readThrough("annotations", "doc1", (json) => updates.push(json));
    assert.deepEqual(result.json, { v: 1 });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(updates, [{ v: 2 }]);
  });

  it("unsent local work from a previous session is pushed on the next read", async () => {
    const { client, local, calls } = setup(() => ({ status: 200, body: { version: "5" } }));
    await local.put({ id: client.idOf("annotations", "doc1"), kind: "annotations", key: "doc1", json: { v: 9 }, version: null, savedAt: 1, dirty: true });
    const result = await client.readThrough("annotations", "doc1");
    assert.deepEqual(result.json, { v: 9 });
    await client.flush("annotations", "doc1");
    assert.equal(calls.filter((call) => call.method === "PUT").length, 1);
  });
});
