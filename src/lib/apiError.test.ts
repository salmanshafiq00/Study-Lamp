import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ApiRequestError,
  apiErrorFromResponse,
  getApiErrorCode,
  getApiErrorMessage,
  readApiResponseBody,
} from "./apiError";

describe("ApiRequestError", () => {
  it("carries the API's stable code and message", () => {
    const error = apiErrorFromResponse(
      new Response("", { status: 422 }),
      { error: "Paste the transcript below to continue.", code: "transcript_blocked" },
    );

    assert.ok(error instanceof ApiRequestError);
    assert.equal(error.message, "Paste the transcript below to continue.");
    assert.equal(getApiErrorCode(error), "transcript_blocked");
    assert.equal(getApiErrorMessage(error, "fallback"), "Paste the transcript below to continue.");
  });

  it("falls back for non-API errors and missing fields", () => {
    assert.equal(getApiErrorCode(new Error("plain")), undefined);
    assert.equal(getApiErrorMessage(new Error(""), "fallback"), "fallback");
    assert.equal(getApiErrorMessage("not an error", "fallback"), "fallback");

    const error = apiErrorFromResponse(new Response("", { status: 500 }), {});
    assert.equal(error.message, "Request failed (500)");
    assert.equal(error.code, undefined);
  });
});

describe("readApiResponseBody", () => {
  it("returns JSON objects and ignores arrays, primitives and invalid JSON", async () => {
    assert.deepEqual(await readApiResponseBody(new Response('{"error":"x"}')), { error: "x" });
    assert.deepEqual(await readApiResponseBody(new Response("[1,2]")), {});
    assert.deepEqual(await readApiResponseBody(new Response('"text"')), {});
    assert.deepEqual(await readApiResponseBody(new Response("not json")), {});
  });
});
