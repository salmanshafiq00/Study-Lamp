import assert from "node:assert/strict";
import { after, describe, it } from "node:test";

import {
  DriveApiError,
  exportFile,
  fetchDocumentBytes,
  isSupportedUploadMimeType,
  isValidDriveConnectionId,
  isValidDriveId,
  sanitizeDriveFileName,
} from "./googleDrive";

describe("Drive identifiers", () => {
  it("accepts only bounded Drive and connection IDs", () => {
    assert.equal(isValidDriveId("0123456789_abcdefghij"), true);
    assert.equal(isValidDriveId("../private"), false);
    assert.equal(isValidDriveId("short"), false);
    assert.equal(isValidDriveConnectionId("AbCd0123456789xyzXYZ"), true);
    assert.equal(isValidDriveConnectionId("../connection"), false);
  });

  it("accepts only supported upload MIME types and sanitizes filenames", () => {
    assert.equal(isSupportedUploadMimeType("video/mp4"), true);
    assert.equal(isSupportedUploadMimeType("application/pdf"), true);
    assert.equal(isSupportedUploadMimeType("application/octet-stream"), false);
    assert.equal(sanitizeDriveFileName("../folder\\video\u0000.mp4"), "..foldervideo.mp4");
    assert.equal(sanitizeDriveFileName("n".repeat(220)).length, 200);
  });
});

describe("fetchDocumentBytes routing", () => {
  const realFetch = globalThis.fetch;
  const fileId = "0123456789_fileABC";
  const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  let calls: string[] = [];

  function stubFetch(response: () => Response) {
    calls = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return response();
    }) as typeof fetch;
  }

  after(() => { globalThis.fetch = realFetch; });

  it("exports a native Google Doc as .docx", async () => {
    stubFetch(() => new Response("bytes", { status: 200 }));
    await fetchDocumentBytes("token", { driveFileId: fileId, mimeType: "application/vnd.google-apps.document", googleNative: true });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes(`/files/${fileId}/export?`));
    assert.ok(calls[0].includes(encodeURIComponent(docxMime)));
  });

  it("downloads regular files with alt=media", async () => {
    stubFetch(() => new Response("bytes", { status: 200 }));
    await fetchDocumentBytes("token", { driveFileId: fileId, mimeType: "application/pdf" });
    assert.ok(calls[0].includes("alt=media"));
    assert.ok(!calls[0].includes("/export"));
  });

  it("rejects an unsupported native type without calling Drive", async () => {
    stubFetch(() => new Response("x"));
    await assert.rejects(fetchDocumentBytes("token", { driveFileId: fileId, mimeType: "application/vnd.google-apps.presentation", googleNative: true }));
    assert.equal(calls.length, 0);
  });
});

describe("exportFile error classification", () => {
  const realFetch = globalThis.fetch;
  const fileId = "0123456789_fileABC";
  const docxMime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

  after(() => { globalThis.fetch = realFetch; });

  async function failure(status: number, body: unknown): Promise<DriveApiError> {
    globalThis.fetch = (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    try {
      await exportFile("token", fileId, docxMime);
    } catch (error) {
      assert.ok(error instanceof DriveApiError);
      return error;
    }
    throw new Error("expected exportFile to throw");
  }

  it("reports the size limit as too_large", async () => {
    const error = await failure(403, { error: { errors: [{ reason: "exportSizeLimitExceeded" }] } });
    assert.equal(error.code, "too_large");
  });

  it("reports other 403s as permission, never as too large", async () => {
    const error = await failure(403, { error: { errors: [{ reason: "insufficientFilePermissions" }] } });
    assert.equal(error.code, "permission");
    assert.ok(!error.message.includes("too large"));
  });

  it("reports 404 as not_found and never includes Google's message text", async () => {
    const error = await failure(404, { error: { message: "secret google detail" } });
    assert.equal(error.code, "not_found");
    assert.ok(!error.message.includes("secret"));
  });

  it("rejects unsupported export MIME types before any request", async () => {
    let called = false;
    globalThis.fetch = (async () => { called = true; return new Response("x"); }) as typeof fetch;
    await assert.rejects(exportFile("token", fileId, "application/pdf"));
    assert.equal(called, false);
  });
});
