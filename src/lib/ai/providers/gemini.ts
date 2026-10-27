import { AiServiceError } from "../errors";
import type { AiConnectionCredentials, AiGenerateOptions } from "../types";
import { resolveAiGenerateOptions } from "../generateOptions";
import { MAX_TRANSCRIPT_CHARS } from "../transcriptLimits";

/**
 * Gemini adapter. This is the ONLY file in the codebase that should know:
 *   - Gemini's request/response JSON shape
 *   - Gemini's auth mechanism (x-goog-api-key header)
 *   - Gemini's model-path URL format
 *   - how to turn a Gemini error/HTTP status into an AiServiceError
 *
 * Nothing outside src/lib/ai/ should import this file directly — always go
 * through src/lib/ai/aiService.ts's generateVideoSummary(). That keeps a
 * future OpenAI/Anthropic adapter (Phase 8/9) a drop-in, and keeps video
 * components from ever depending on a Gemini SDK/response shape.
 */

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GENERATE_TIMEOUT_MS = 30_000;
const VALIDATE_TIMEOUT_MS = 10_000;
// Keep well below both route maxDuration values (60 s) so the summary/quiz
// generation call still has budget after transcription finishes.
const TRANSCRIBE_TIMEOUT_MS = 35_000;
const MAX_TRANSCRIPT_OUTPUT_TOKENS = 16_384;
const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

export const YOUTUBE_TRANSCRIPT_PROMPT =
  "Transcribe the spoken words in this video as plain text. Write the transcript in the language that is spoken. " +
  "Do not add commentary, headings, timestamps, or speaker labels.";

async function withTimeout<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort extraction of Gemini's own error message, so translated
 *  errors are informative without ever including the API key (the key is
 *  only ever in the request URL, never in a response body we might log). */
function extractGeminiMessage(body: any): string | undefined {
  return body?.error?.message;
}

function translateHttpError(status: number, body: any): AiServiceError {
  const detail = extractGeminiMessage(body);

  if (status === 401 || status === 403) {
    return new AiServiceError("auth", "Gemini rejected this API key.");
  }
  if (status === 429) {
    return new AiServiceError("rate_limit", "Gemini rate-limited this request.");
  }
  if (status === 400) {
    // Gemini uses 400 both for "malformed request" and "unknown model" —
    // both are invalid_request, not something a fallback key would fix.
    return new AiServiceError(
      "invalid_request",
      detail ? `Gemini rejected the request: ${detail}` : "Gemini rejected the request."
    );
  }
  if (status === 404) {
    return new AiServiceError("invalid_request", "Gemini model not found for this connection.");
  }
  if (status >= 500) {
    return new AiServiceError("server_error", `Gemini returned a server error (status ${status}).`);
  }
  return new AiServiceError("unknown", `Gemini returned an unexpected error (status ${status}).`);
}

/** Parses a generateContent response into plain text, or throws a
 *  classified AiServiceError for the shapes that aren't "here's your text"
 *  (blocked prompt, empty candidates, unexpected shape). */
function parseGenerateContentResponse(body: any): string {
  const blockReason = body?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new AiServiceError("blocked", `Gemini declined to answer (reason: ${blockReason}).`);
  }

  const candidate = body?.candidates?.[0];
  const finishReason = candidate?.finishReason;
  if (finishReason === "SAFETY" || finishReason === "RECITATION") {
    throw new AiServiceError("blocked", `Gemini declined to answer (reason: ${finishReason}).`);
  }

  const parts = candidate?.content?.parts;
  const text = Array.isArray(parts)
    ? parts.map((p: any) => (typeof p?.text === "string" ? p.text : "")).join("")
    : undefined;

  if (!text || !text.trim()) {
    throw new AiServiceError("unknown", "Gemini returned an empty response.");
  }
  return text.trim();
}

/**
 * Sends `prompt` to Gemini using `credentials` and returns the plain-text
 * answer. Callers should go through aiService.generateVideoSummary rather
 * than calling this directly.
 */
/** Gemini 2.5-series models spend "thinking" tokens from the maxOutputTokens budget. */
export function isGemini25Model(model: string): boolean {
  return model.includes("gemini-2.5");
}

/** Shared generationConfig builder so every Gemini call gets the same thinking handling. */
function buildGenerationConfig(
  credentials: AiConnectionCredentials,
  options: AiGenerateOptions | undefined,
  includeThinkingConfig: boolean,
) {
  const settings = resolveAiGenerateOptions(options);
  return {
    temperature: settings.temperature,
    maxOutputTokens: settings.maxOutputTokens,
    // Gemini's JSON mode accepts array roots too.
    ...(settings.json ? { responseMimeType: "application/json" } : {}),
    ...(includeThinkingConfig && settings.disableThinking && isGemini25Model(credentials.model)
      ? { thinkingConfig: { thinkingBudget: 0 } }
      : {}),
  };
}

/** Request body for generateContent. `thinkingConfig` is only added for 2.5 models when thinking should be off. */
export function buildGeminiRequestBody(
  credentials: AiConnectionCredentials,
  prompt: string,
  options: AiGenerateOptions | undefined,
  includeThinkingConfig = true,
) {
  return {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: buildGenerationConfig(credentials, options, includeThinkingConfig),
  };
}

export function isValidYouTubeVideoId(videoId: string): boolean {
  return YOUTUBE_VIDEO_ID_PATTERN.test(videoId);
}

/**
 * Pure request body for the Gemini-from-URL transcript fallback. The file URI
 * is exactly the public watch URL, and no API key is ever part of the body.
 */
export function buildYouTubeTranscriptRequestBody(
  credentials: AiConnectionCredentials,
  videoId: string,
  includeThinkingConfig = true,
) {
  if (!isValidYouTubeVideoId(videoId)) {
    throw new AiServiceError("invalid_request", "Invalid YouTube video id.");
  }

  return {
    contents: [
      {
        role: "user",
        parts: [
          { fileData: { fileUri: `https://www.youtube.com/watch?v=${videoId}` } },
          { text: YOUTUBE_TRANSCRIPT_PROMPT },
        ],
      },
    ],
    generationConfig: buildGenerationConfig(
      credentials,
      { maxOutputTokens: MAX_TRANSCRIPT_OUTPUT_TOKENS, temperature: 0, disableThinking: true },
      includeThinkingConfig,
    ),
  };
}

export async function generateWithGemini(
  credentials: AiConnectionCredentials,
  prompt: string,
  options?: AiGenerateOptions,
): Promise<string> {
  const url = `${BASE_URL}/${encodeURIComponent(credentials.model)}:generateContent`;

  async function send(includeThinkingConfig: boolean): Promise<{ res: Response; body: any }> {
    let res: Response;
    try {
      res = await withTimeout(GENERATE_TIMEOUT_MS, (signal) =>
        fetch(url, {
          method: "POST",
          signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": credentials.apiKey },
          body: JSON.stringify(buildGeminiRequestBody(credentials, prompt, options, includeThinkingConfig)),
        })
      );
    } catch (err: any) {
      if (err?.name === "AbortError") {
        throw new AiServiceError("timeout", "Timed out waiting for Gemini.");
      }
      throw new AiServiceError("network", "Could not reach Gemini.");
    }
    return { res, body: await res.json().catch(() => null) };
  }

  let { res, body } = await send(true);
  // Some 2.5 models (e.g. Pro) cannot switch thinking off and answer 400 about the thinking budget.
  // Retry once without thinkingConfig instead of failing the request.
  if (res.status === 400 && /thinking/i.test(String(extractGeminiMessage(body) ?? ""))
      && buildGeminiRequestBody(credentials, prompt, options).generationConfig.thinkingConfig) {
    ({ res, body } = await send(false));
  }
  if (!res.ok) {
    throw translateHttpError(res.status, body);
  }
  return parseGenerateContentResponse(body);
}

/**
 * Free workaround for YouTube blocking datacenter IPs: Gemini fetches the
 * public video URL itself and transcribes the audio. This is a preview
 * feature (public videos only) and must never be used for non-Gemini
 * providers. Errors are already mapped to AiServiceError, so callers can turn
 * any failure into "no transcript".
 */
export async function transcribeYouTubeWithGemini(
  credentials: AiConnectionCredentials,
  videoId: string,
  signal?: AbortSignal,
): Promise<string> {
  // Validate before any network call so a malformed id never reaches Google.
  buildYouTubeTranscriptRequestBody(credentials, videoId);

  const url = `${BASE_URL}/${encodeURIComponent(credentials.model)}:generateContent`;

  async function send(includeThinkingConfig: boolean): Promise<{ res: Response; body: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
    const forwardAbort = () => controller.abort();
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", forwardAbort, { once: true });
    }

    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          signal: controller.signal,
          headers: { "Content-Type": "application/json", "x-goog-api-key": credentials.apiKey },
          body: JSON.stringify(buildYouTubeTranscriptRequestBody(credentials, videoId, includeThinkingConfig)),
        });
      } catch (err: unknown) {
        if (err instanceof Error && err.name === "AbortError") {
          throw new AiServiceError("timeout", "Timed out waiting for Gemini.");
        }
        throw new AiServiceError("network", "Could not reach Gemini.");
      }
      return { res, body: await res.json().catch(() => null) };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  let { res, body } = await send(true);
  // Some 2.5 models cannot switch thinking off and answer 400 about the
  // thinking budget; retry once without thinkingConfig, same as generation.
  if (
    res.status === 400 &&
    /thinking/i.test(String(extractGeminiMessage(body) ?? "")) &&
    isGemini25Model(credentials.model)
  ) {
    ({ res, body } = await send(false));
  }
  if (!res.ok) throw translateHttpError(res.status, body);
  return parseGenerateContentResponse(body).slice(0, MAX_TRANSCRIPT_CHARS);
}

/**
 * Lightweight key check used by the "Test Connection" flow (Phase 2's
 * POST /api/ai/connections/:id/test). Uses a read-only models.list call so
 * testing a connection doesn't spend generation quota. This replaces the
 * route's previous self-contained checkGeminiKey — Gemini-specific
 * validation logic now lives in exactly one place.
 */
export async function validateGeminiConnection(
  apiKey: string
): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await withTimeout(VALIDATE_TIMEOUT_MS, (signal) =>
      fetch(BASE_URL, { signal, headers: { "x-goog-api-key": apiKey } })
    );

    if (res.ok) return { ok: true, message: "Connection verified." };
    if (res.status === 400 || res.status === 401 || res.status === 403) {
      return { ok: false, message: "Gemini rejected this API key." };
    }
    return { ok: false, message: `Gemini returned an unexpected error (status ${res.status}).` };
  } catch (err: any) {
    if (err?.name === "AbortError") {
      return { ok: false, message: "Timed out reaching Gemini." };
    }
    return { ok: false, message: "Could not reach Gemini." };
  }
}
