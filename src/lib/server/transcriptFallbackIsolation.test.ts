/**
 * Tests that the geminiFallback wrapper in summary/route.ts and
 * quiz/generate/route.ts correctly shields withAiConnection from
 * transcription errors, preventing the user's key from being marked
 * invalid/cooldown and preventing system quota from being burned.
 *
 * We test the pattern directly via withAiConnection's injectable deps,
 * because the route files themselves are Next.js edge runtime code that
 * can't be imported in a plain Node test.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { withAiConnection } from "./resolveAiConnection";
import { AiServiceError } from "../ai/errors";

/** Minimal stub for a personal connection. */
function makePersonalConnection(overrides: Record<string, unknown> = {}) {
  return {
    id: "personal-1",
    provider: "gemini" as const,
    encryptedApiKey: "encrypted",
    maskedKey: "••••",
    model: "gemini-2.5-flash",
    label: "My key",
    priority: 0,
    isActive: true,
    status: "active" as const,
    cooldownUntil: null,
    lastUsedAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

/**
 * Simulates the geminiFallback wrapper used in both routes:
 *   - any AiServiceError thrown by transcribeYouTubeWithGemini is caught and
 *     rethrown as AiServiceError("unknown", …)
 *   - "unknown" is NOT in FALLBACK_CODES, so withAiConnection exits
 *     immediately without recording a connection failure
 */
function makeTranscribeFallback(
  uid: string,
  transcribeImpl: (apiKey: string) => Promise<string>
) {
  return (videoId: string) =>
    withAiConnection(
      uid,
      async (apiKey, provider) => {
        if (provider !== "gemini") {
          throw new AiServiceError("unsupported_provider", "Gemini only.");
        }
        try {
          return await transcribeImpl(apiKey);
        } catch (err) {
          if (err instanceof AiServiceError && err.code === "unknown") throw err;
          throw new AiServiceError(
            "unknown",
            err instanceof Error ? err.message : "Transcription failed."
          );
        }
      },
      {
        getPersonalConnectionRaw: async () => makePersonalConnection(),
        getSystemConnectionRaw: async () => null,
        consumeQuota: async () => true,
        decryptApiKey: () => "decrypted-key",
        recordPersonalTestResult: async () => undefined,
        recordPersonalConnectionFailure: async () => {
          // This must NOT be called when a transcription fails.
          assert.fail("recordPersonalConnectionFailure must not be called for a transcription error");
        },
        recordSystemTestResult: async () => undefined,
        recordSystemConnectionFailure: async () => {
          assert.fail("recordSystemConnectionFailure must not be called for a transcription error");
        },
      }
    );
}

describe("geminiFallback transcription error isolation", () => {
  it("does not record a connection failure when transcription throws rate_limit", async () => {
    const fallback = makeTranscribeFallback("uid-1", async () => {
      throw new AiServiceError("rate_limit", "Quota exceeded");
    });

    await assert.rejects(
      () => fallback("dQw4w9WgXcQ"),
      (err: unknown) => {
        assert.ok(err instanceof AiServiceError);
        // The outer withAiConnection re-wraps as "unknown"
        assert.equal(err.code, "unknown");
        return true;
      }
    );
    // If we reach here, recordPersonalConnectionFailure was NOT called (the
    // assert.fail inside would have aborted the test).
  });

  it("does not record a connection failure when transcription throws auth", async () => {
    const fallback = makeTranscribeFallback("uid-1", async () => {
      throw new AiServiceError("auth", "Invalid API key");
    });

    await assert.rejects(
      () => fallback("dQw4w9WgXcQ"),
      (err: unknown) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, "unknown");
        return true;
      }
    );
  });

  it("does not record a connection failure when transcription throws network", async () => {
    const fallback = makeTranscribeFallback("uid-1", async () => {
      throw new AiServiceError("network", "Could not reach Gemini");
    });

    await assert.rejects(
      () => fallback("dQw4w9WgXcQ"),
      (err: unknown) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, "unknown");
        return true;
      }
    );
  });

  it("does not record a connection failure when transcription throws a plain Error", async () => {
    const fallback = makeTranscribeFallback("uid-1", async () => {
      throw new TypeError("unexpected network failure");
    });

    await assert.rejects(
      () => fallback("dQw4w9WgXcQ"),
      (err: unknown) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, "unknown");
        assert.equal(err.message, "unexpected network failure");
        return true;
      }
    );
  });

  it("passes through cleanly when transcription succeeds", async () => {
    const fallback = makeTranscribeFallback("uid-1", async () => "the transcript text");
    const result = await fallback("dQw4w9WgXcQ");
    assert.equal(result, "the transcript text");
  });

  it("preserves an already-unknown AiServiceError without double-wrapping", async () => {
    const fallback = makeTranscribeFallback("uid-1", async () => {
      throw new AiServiceError("unknown", "something unusual");
    });

    await assert.rejects(
      () => fallback("dQw4w9WgXcQ"),
      (err: unknown) => {
        assert.ok(err instanceof AiServiceError);
        assert.equal(err.code, "unknown");
        assert.equal(err.message, "something unusual");
        return true;
      }
    );
  });
});

