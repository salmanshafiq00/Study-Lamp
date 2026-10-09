import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NextRequest } from "next/server";
import { BlobStoreError } from "./driveBlobStore";
import { createBlobHandlers, readTextCapped, type BlobParams, type BlobRouteDeps } from "./blobRouteHandlers";
import { createAuthedRoute } from "./routeHelpers";

function fakeDeps(overrides: Partial<BlobRouteDeps> = {}) {
  const calls: string[] = [];
  const deps: BlobRouteDeps = {
    async get(_uid, kind, key) { calls.push(`get:${kind}:${key}`); return { json: { hello: 1 }, version: "3" }; },
    async put(_uid, kind, key, text) { calls.push(`put:${kind}:${key}`); return { bytes: text.length, version: "4" }; },
    async del(_uid, kind, key) { calls.push(`del:${kind}:${key}`); return true; },
    async ownsDocument(_uid, id) { return id !== "someoneElsesDoc"; },
    ...overrides,
  };
  return { deps, calls };
}

const params = (kind: string, key: string): { params: BlobParams } => ({ params: { kind, key } });
const authed = (method: string, body?: string) => new NextRequest("http://localhost/api/blobs/x/y", { method, headers: { authorization: "Bearer t" }, body });

describe("blob routes", () => {
  it("401 without authentication", async () => {
    const { deps } = fakeDeps();
    const route = createAuthedRoute<BlobParams>(async () => null, createBlobHandlers(deps).get);
    const response = await route(new NextRequest("http://localhost/x"), params("annotations", "doc1"));
    assert.equal(response.status, 401);
  });

  it("400 for a bad kind or key, before any store call", async () => {
    const { deps, calls } = fakeDeps();
    const route = createAuthedRoute<BlobParams>(async () => "u1", createBlobHandlers(deps).get);
    assert.equal((await route(authed("GET"), params("secrets", "doc1"))).status, 400);
    assert.equal((await route(authed("GET"), params("annotations", "../x"))).status, 400);
    assert.deepEqual(calls, []);
  });

  it("404 for a document the caller does not own", async () => {
    const { deps, calls } = fakeDeps();
    const route = createAuthedRoute<BlobParams>(async () => "u1", createBlobHandlers(deps).get);
    assert.equal((await route(authed("GET"), params("annotations", "someoneElsesDoc"))).status, 404);
    assert.deepEqual(calls, []);
  });

  it("GET success returns the stored JSON", async () => {
    const { deps } = fakeDeps();
    const route = createAuthedRoute<BlobParams>(async () => "u1", createBlobHandlers(deps).get);
    const response = await route(authed("GET"), params("annotations", "doc1"));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { json: { hello: 1 }, version: "3" });
  });

  it("PUT validates the body and stores it", async () => {
    const { deps, calls } = fakeDeps();
    const route = createAuthedRoute<BlobParams>(async () => "u1", createBlobHandlers(deps).put);
    assert.equal((await route(authed("PUT", "not json"), params("annotations", "doc1"))).status, 400);
    assert.equal((await route(authed("PUT", "42"), params("annotations", "doc1"))).status, 400);
    const ok = await route(authed("PUT", JSON.stringify({ annotations: [] })), params("annotations", "doc1"));
    assert.equal(ok.status, 200);
    assert.deepEqual(calls, ["put:annotations:doc1"]);
  });

  it("PUT over the cap returns 413 without calling the store", async () => {
    const { deps, calls } = fakeDeps();
    const route = createAuthedRoute<BlobParams>(async () => "u1", createBlobHandlers(deps).put);
    const big = JSON.stringify({ x: "a".repeat(2 * 1024 * 1024 + 10) });
    assert.equal((await route(authed("PUT", big), params("annotations", "doc1"))).status, 413);
    assert.deepEqual(calls, []);
  });

  it("maps store errors to generic responses with a code", async () => {
    const { deps } = fakeDeps({ async put() { throw new BlobStoreError("scope_missing"); } });
    const route = createAuthedRoute<BlobParams>(async () => "u1", createBlobHandlers(deps).put);
    const response = await route(authed("PUT", "{}"), params("annotations", "doc1"));
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { error: "Reconnect Google Drive.", code: "reconnect" });
  });

  it("DELETE reports whether something was removed", async () => {
    const { deps } = fakeDeps();
    const route = createAuthedRoute<BlobParams>(async () => "u1", createBlobHandlers(deps).del);
    assert.deepEqual(await (await route(authed("DELETE"), params("doctext", "doc1"))).json(), { deleted: true });
  });

  it("readTextCapped stops reading past the cap", async () => {
    assert.equal(await readTextCapped(new Request("http://x", { method: "POST", body: "a".repeat(100) }), 50), null);
    assert.equal(await readTextCapped(new Request("http://x", { method: "POST", body: "abc" }), 50), "abc");
  });
});
