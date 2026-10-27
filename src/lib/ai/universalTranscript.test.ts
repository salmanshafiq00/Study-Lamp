import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";

import { TranscriptUnavailableError } from "./transcript";
import { resolveTranscript, resolveTranscriptDetailed } from "./universalTranscript";

describe("resolveTranscriptDetailed", () => {
  const originalConsoleError = console.error;

  afterEach(() => {
    console.error = originalConsoleError;
  });

  it("prefers the learner's own transcript and makes no network calls", async () => {
    let youtubeCalls = 0;
    let geminiCalls = 0;
    const result = await resolveTranscriptDetailed(
      { youtubeVideoId: "abcdefghijk", manualTranscript: "  my own words  " },
      {
        fetchYouTubeTranscript: async () => {
          youtubeCalls += 1;
          return "captions";
        },
        geminiFallback: async () => {
          geminiCalls += 1;
          return "gemini";
        },
      },
    );

    assert.deepEqual(result, { text: "my own words", source: "manual", failureReason: null });
    assert.equal(youtubeCalls, 0);
    assert.equal(geminiCalls, 0);
  });

  it("uses YouTube captions when there is no manual transcript", async () => {
    const result = await resolveTranscriptDetailed(
      { youtubeVideoId: "abcdefghijk", manualTranscript: "  " },
      { fetchYouTubeTranscript: async () => "captions", geminiFallback: async () => "gemini" },
    );

    assert.deepEqual(result, { text: "captions", source: "youtube", failureReason: null });
  });

  it("falls back to Gemini-from-URL after a blocked caption fetch", async () => {
    const result = await resolveTranscriptDetailed(
      { youtubeVideoId: "abcdefghijk" },
      {
        fetchYouTubeTranscript: async () => {
          throw new TranscriptUnavailableError(undefined, "blocked");
        },
        geminiFallback: async (videoId) => {
          assert.equal(videoId, "abcdefghijk");
          return "gemini transcript";
        },
      },
    );

    assert.deepEqual(result, { text: "gemini transcript", source: "gemini-url", failureReason: null });
  });

  it("returns the failure reason when there is no fallback", async () => {
    const result = await resolveTranscriptDetailed(
      { youtubeVideoId: "abcdefghijk" },
      {
        fetchYouTubeTranscript: async () => {
          throw new TranscriptUnavailableError(undefined, "no_captions");
        },
      },
    );

    assert.deepEqual(result, { text: null, source: null, failureReason: "no_captions" });
  });

  it("keeps the YouTube failure reason when the Gemini fallback fails, and logs only its name", async () => {
    const log = mock.method(console, "error", () => {});

    const result = await resolveTranscriptDetailed(
      { youtubeVideoId: "abcdefghijk" },
      {
        fetchYouTubeTranscript: async () => {
          throw new TranscriptUnavailableError(undefined, "blocked");
        },
        geminiFallback: async () => {
          throw new Error("secret provider detail");
        },
      },
    );

    assert.deepEqual(result, { text: null, source: null, failureReason: "blocked" });
    assert.equal(log.mock.calls.length, 1);
    const logged = String(log.mock.calls[0]?.arguments[0]);
    assert.equal(logged, "Gemini transcript fallback failed: Error");
    assert.equal(logged.includes("secret provider detail"), false);
  });

  it("treats an unexpected caption error as unknown but still lets Gemini try", async () => {
    const log = mock.method(console, "error", () => {});

    const result = await resolveTranscriptDetailed(
      { youtubeVideoId: "abcdefghijk" },
      {
        fetchYouTubeTranscript: async () => {
          throw new TypeError("network blew up");
        },
        geminiFallback: async () => "gemini transcript",
      },
    );

    assert.deepEqual(result, { text: "gemini transcript", source: "gemini-url", failureReason: null });
    assert.equal(String(log.mock.calls[0]?.arguments[0]), "Unexpected error fetching YouTube transcript: TypeError");
  });

  it("returns unknown when every source is empty and there is no YouTube id", async () => {
    const result = await resolveTranscriptDetailed({ manualTranscript: "   " });
    assert.deepEqual(result, { text: null, source: null, failureReason: "unknown" });
  });

  it("resolveTranscript is a text-only wrapper", async () => {
    const text = await resolveTranscript({ manualTranscript: "my own words" });
    assert.equal(text, "my own words");
  });
});
