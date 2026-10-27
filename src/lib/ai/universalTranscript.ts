import { getYouTubeTranscript, TranscriptUnavailableError, type TranscriptFailureReason } from "./transcript";
import { logServerError } from "@/lib/server/logError";

export type { TranscriptFailureReason } from "./transcript";

/**
 * Phase 4 (roadmap v3) — one transcript pipeline for every platform.
 *
 * Priority order:
 *   1. the learner's own pasted/uploaded transcript (their text, no network);
 *   2. official YouTube captions;
 *   3. an optional Gemini-from-URL fallback (Gemini fetches the public video
 *      itself, so it is not affected by YouTube blocking our server IP);
 *   4. nothing, with the reason the learner can act on.
 *
 * Automatic speech-to-text (src/lib/ai/audioTranscribe.ts) is a deliberate
 * follow-up, not a step here — see that file's header comment.
 *
 * Deliberately has no Firestore/React dependency, same reasoning as
 * buildVideoSourceHash in src/lib/quizSource.ts: callers (API routes) fetch
 * whatever they already have (youtubeVideoId from the request body, the
 * saved manual transcript from users/{uid}/transcripts/{videoId}) and hand
 * it to this function rather than this function reading Firestore itself,
 * which keeps it usable from both server routes and tests.
 */
export interface TranscriptSource {
  /** Present only for youtube/youtube-shorts videos. */
  youtubeVideoId?: string | null;
  /** The learner's own pasted/uploaded transcript, if one has been saved. */
  manualTranscript?: string | null;
}

export type TranscriptSourceKind = "manual" | "youtube" | "gemini-url";

export interface DetailedTranscriptResult {
  text: string | null;
  source: TranscriptSourceKind | null;
  failureReason: TranscriptFailureReason | null;
}

export interface ResolveTranscriptOptions {
  /** Free Gemini-from-URL fallback. Passed only when the resolved AI connection is Gemini. */
  geminiFallback?: (videoId: string) => Promise<string>;
  /** Test seam; defaults to the real YouTube caption fetcher. */
  fetchYouTubeTranscript?: (videoId: string) => Promise<string>;
}

export async function resolveTranscriptDetailed(
  video: TranscriptSource,
  options: ResolveTranscriptOptions = {},
): Promise<DetailedTranscriptResult> {
  // 1. The learner's own text always wins and avoids a pointless (and often
  //    blocked) YouTube request.
  const manual = (video.manualTranscript || "").trim();
  if (manual) return { text: manual, source: "manual", failureReason: null };

  const youtubeId = (video.youtubeVideoId || "").trim();
  let failureReason: TranscriptFailureReason = "unknown";

  // 2. Official captions.
  if (youtubeId) {
    const fetchYouTube = options.fetchYouTubeTranscript ?? getYouTubeTranscript;
    try {
      const transcript = await fetchYouTube(youtubeId);
      if (transcript.trim()) return { text: transcript, source: "youtube", failureReason: null };
    } catch (error) {
      if (error instanceof TranscriptUnavailableError) {
        failureReason = error.reason ?? "unknown";
      } else {
        // A genuinely unexpected error is logged (name/status/code only) and
        // treated as "unknown"; this function's contract is "best available
        // transcript, or a reason", never a throw.
        logServerError("Unexpected error fetching YouTube transcript", error);
      }
    }
  }

  // 3. Optional Gemini-from-URL fallback. Any failure is just "no
  //    transcript", never a 500.
  if (youtubeId && options.geminiFallback) {
    try {
      const transcript = await options.geminiFallback(youtubeId);
      if (transcript.trim()) return { text: transcript, source: "gemini-url", failureReason: null };
    } catch (error) {
      logServerError("Gemini transcript fallback failed", error);
    }
  }

  return { text: null, source: null, failureReason };
}

/** Thin wrapper kept for callers that only need the text. */
export async function resolveTranscript(video: TranscriptSource): Promise<string | null> {
  return (await resolveTranscriptDetailed(video)).text;
}
