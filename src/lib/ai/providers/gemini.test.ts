import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { generateWithGemini, validateGeminiConnection } from "./gemini";
import {
  buildYouTubeTranscriptRequestBody,
  isValidYouTubeVideoId,
  transcribeYouTubeWithGemini,
  YOUTUBE_TRANSCRIPT_PROMPT,
} from "./gemini";
import { AiServiceError } from "../errors";
import { MAX_TRANSCRIPT_CHARS } from "../transcriptLimits";
import type { AiConnectionCredentials } from "../types";

type FetchArgs = Parameters<typeof fetch>;

describe("Gemini API-key header handling", () => {
  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  let requestHeaders: HeadersInit | undefined;

  before(() => {
    globalThis.fetch = (async (...args: FetchArgs) => {
      requestedUrl = String(args[0]);
      requestHeaders = args[1]?.headers;
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: "generated" }] } }] }), { status: 200 });
    }) as typeof fetch;
  });

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends generation keys in the header, never in the URL", async () => {
    const credentials: AiConnectionCredentials = { provider: "gemini", apiKey: "test-secret-key", model: "gemini-test" };
    assert.equal(await generateWithGemini(credentials, "prompt"), "generated");
    assert.equal(new URL(requestedUrl).searchParams.has("key"), false);
    assert.equal(new Headers(requestHeaders).get("x-goog-api-key"), "test-secret-key");
  });

  it("sends validation keys in the header, never in the URL", async () => {
    const result = await validateGeminiConnection("test-secret-key");
    assert.equal(result.ok, true);
    assert.equal(new URL(requestedUrl).searchParams.has("key"), false);
    assert.equal(new Headers(requestHeaders).get("x-goog-api-key"), "test-secret-key");
  });
});

describe("Gemini YouTube transcript fallback", () => {
  const credentials: AiConnectionCredentials = {
    provider: "gemini",
    apiKey: "test-secret-key",
    model: "gemini-2.5-flash",
  };

  it("accepts only 11-character YouTube ids", () => {
    assert.equal(isValidYouTubeVideoId("dQw4w9WgXcQ"), true);
    assert.equal(isValidYouTubeVideoId("abc_DEF-123"), true);
    assert.equal(isValidYouTubeVideoId("too-short"), false);
    assert.equal(isValidYouTubeVideoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), false);
    assert.equal(isValidYouTubeVideoId(""), false);
  });

  it("builds the exact public watch URL as fileData, with the prompt as a text part", () => {
    const body = buildYouTubeTranscriptRequestBody(credentials, "dQw4w9WgXcQ");

    assert.equal(body.contents[0].role, "user");
    assert.deepEqual(body.contents[0].parts[0], {
      fileData: { fileUri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    });
    assert.deepEqual(body.contents[0].parts[1], { text: YOUTUBE_TRANSCRIPT_PROMPT });
    assert.equal(body.generationConfig.temperature, 0);
    assert.equal(body.generationConfig.maxOutputTokens, 16_384);
    assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
    assert.equal(JSON.stringify(body).includes("test-secret-key"), false);
  });

  it("omits thinkingConfig when asked, or for non-2.5 models", () => {
    assert.equal(
      "thinkingConfig" in buildYouTubeTranscriptRequestBody(credentials, "dQw4w9WgXcQ", false).generationConfig,
      false,
    );
    assert.equal(
      "thinkingConfig" in
        buildYouTubeTranscriptRequestBody({ ...credentials, model: "gemini-2.0-flash" }, "dQw4w9WgXcQ")
          .generationConfig,
      false,
    );
  });

  it("rejects a malformed id before any network call", () => {
    assert.throws(
      () => buildYouTubeTranscriptRequestBody(credentials, "not-a-video-id"),
      (error: unknown) => error instanceof AiServiceError && error.code === "invalid_request",
    );
  });
});

describe("transcribeYouTubeWithGemini", () => {
  const originalFetch = globalThis.fetch;
  const credentials: AiConnectionCredentials = {
    provider: "gemini",
    apiKey: "test-secret-key",
    model: "gemini-2.5-flash",
  };

  after(() => {
    globalThis.fetch = originalFetch;
  });

  it("posts the fileData URL to generateContent with the key only in the header", async () => {
    let requestedUrl = "";
    let headers: HeadersInit | undefined;
    let body: unknown;

    globalThis.fetch = (async (...args: FetchArgs) => {
      requestedUrl = String(args[0]);
      headers = args[1]?.headers;
      body = JSON.parse(String(args[1]?.body));
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "  hello transcript  " }] } }] }),
        { status: 200 },
      );
    }) as typeof fetch;

    const text = await transcribeYouTubeWithGemini(credentials, "dQw4w9WgXcQ");

    assert.equal(text, "hello transcript");
    assert.match(requestedUrl, /gemini-2\.5-flash:generateContent$/);
    assert.equal(new URL(requestedUrl).searchParams.has("key"), false);
    assert.equal(new Headers(headers).get("x-goog-api-key"), "test-secret-key");
    assert.deepEqual((body as { contents: Array<{ parts: Array<unknown> }> }).contents[0].parts[0], {
      fileData: { fileUri: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" },
    });
  });

  it("truncates a very long transcript to the shared limit", async () => {
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: "x".repeat(MAX_TRANSCRIPT_CHARS + 500) }] } }] }),
        { status: 200 },
      )) as typeof fetch;

    const text = await transcribeYouTubeWithGemini(credentials, "dQw4w9WgXcQ");
    assert.equal(text.length, MAX_TRANSCRIPT_CHARS);
  });

  it("maps HTTP failures through the existing Gemini error translation", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: "quota" } }), { status: 429 })) as typeof fetch;

    await assert.rejects(
      () => transcribeYouTubeWithGemini(credentials, "dQw4w9WgXcQ"),
      (error: unknown) => error instanceof AiServiceError && error.code === "rate_limit",
    );
  });

  it("does not call fetch at all for an invalid id", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    await assert.rejects(
      () => transcribeYouTubeWithGemini(credentials, "not-a-video-id"),
      (error: unknown) => error instanceof AiServiceError && error.code === "invalid_request",
    );
    assert.equal(calls, 0);
  });
});