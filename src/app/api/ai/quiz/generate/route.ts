import { NextResponse } from "next/server";
import { generateVideoQuiz } from "@/lib/ai/aiService";
import { resolveTranscriptDetailed, type TranscriptFailureReason } from "@/lib/ai/universalTranscript";
import { transcriptErrorInfo } from "@/lib/ai/transcriptFailure";
import { AiServiceError } from "@/lib/ai/errors";
import { transcribeYouTubeWithGemini } from "@/lib/ai/providers/gemini";
import { resolveAiLanguage } from "@/lib/server/aiPreferences";
import { getPreferredAiProvider, withAiConnection } from "@/lib/server/resolveAiConnection";
import { logServerError } from "@/lib/server/logError";
import { buildSourceHash } from "@/lib/server/sourceHash";
import {
  getPersonalVideoQuiz,
  getSharedVideoQuiz,
  savePersonalVideoQuiz,
  saveSharedVideoQuiz,
} from "@/lib/server/quiz";
import { aiErrorResponse, withAuthedRoute } from "@/lib/server/routeHelpers";

const TRANSCRIPT_MAX_LENGTH = 50000;

// Calls an AI model; adjust to the deployment plan limit.
export const maxDuration = 60;

export const POST = withAuthedRoute(async ({ uid, req }) => {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const videoId = typeof b.videoId === "string" ? b.videoId.trim() : undefined;
  const playlistId = typeof b.playlistId === "string" ? b.playlistId.trim() : undefined;
  const ownerId = typeof b.ownerId === "string" ? b.ownerId.trim() : undefined;
  const title = typeof b.title === "string" ? b.title : undefined;
  const description = typeof b.description === "string" ? b.description : null;
  const summary = typeof b.summary === "string" ? b.summary : null;
  const youtubeVideoId = typeof b.youtubeVideoId === "string" ? b.youtubeVideoId.trim() : "";
  // Phase 4 (roadmap v3): a non-YouTube video's manually pasted/uploaded
  // transcript (users/{uid}/transcripts/{videoId} — see
  // src/lib/firestore/transcripts.ts), sent by the client the same way
  // `summary` already is.
  const manualTranscript = typeof b.manualTranscript === "string" ? b.manualTranscript : "";
  const language = await resolveAiLanguage(uid, b.language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });
  if (manualTranscript.length > TRANSCRIPT_MAX_LENGTH) {
    return NextResponse.json({ error: "manualTranscript is too long." }, { status: 400 });
  }

  if (!summary?.trim() && !youtubeVideoId && !manualTranscript.trim()) {
    return NextResponse.json({ error: "Add a summary, a transcript, or use a YouTube video with available captions before generating a quiz." }, { status: 422 });
  }
  if (ownerId && ownerId !== uid) {
    return NextResponse.json({ error: "You can only generate quizzes for your own personal videos." }, { status: 403 });
  }
  if (!ownerId && (!playlistId || !videoId)) {
    return NextResponse.json({ error: "A playlistId and videoId are required for a shared video quiz." }, { status: 400 });
  }
  if (ownerId && (!playlistId || !videoId)) {
    return NextResponse.json({ error: "A playlistId and videoId are required for a personal video quiz." }, { status: 400 });
  }

  // Phase 5 (roadmap v3) bug fix: this used to skip fetching a transcript
  // whenever a summary existed, even when a transcript was available —
  // meaning quizzes silently ignored transcript detail the moment a
  // summary was saved. Resolve the transcript FIRST and unconditionally
  // (any platform, via resolveTranscriptDetailed — not just YouTube), and
  // only fall back to the saved summary when no transcript exists at all.
  // buildQuizPrompt's own instructions also prefer transcript > summary,
  // so passing both through is safe either way.
  let transcript: string | null = null;
  let transcriptFailureReason: TranscriptFailureReason | null = null;
  try {
    const preferredProvider = await getPreferredAiProvider(uid).catch(() => null);
    const result = await resolveTranscriptDetailed(
      { youtubeVideoId, manualTranscript },
      preferredProvider === "gemini"
        ? {
            geminiFallback: (vid: string) =>
              withAiConnection(uid, async (apiKey, provider, model) => {
                if (provider !== "gemini") {
                  throw new AiServiceError("unsupported_provider", "Transcript fallback is only available for Gemini.");
                }
                // Rethrow every transcription error as "unknown" so withAiConnection
                // never marks the connection as failed/invalid or burns system quota
                // due to a transcript-specific problem (e.g. Gemini can't access the
                // video URL). The "unknown" code is not in FALLBACK_CODES, so the
                // loop exits immediately without trying the next connection.
                try {
                  return await transcribeYouTubeWithGemini({ provider, apiKey, model }, vid);
                } catch (err) {
                  if (err instanceof AiServiceError && err.code === "unknown") throw err;
                  throw new AiServiceError("unknown", err instanceof Error ? err.message : "Transcription failed.");
                }
              }),
          }
        : undefined
    );
    transcript = result.text;
    transcriptFailureReason = result.failureReason;
  } catch (error) {
    logServerError("Unexpected error resolving a transcript for quiz generation", error);
    transcriptFailureReason = "unknown";
  }

  if (!transcript && !summary?.trim()) {
    const info = transcriptErrorInfo(transcriptFailureReason);
    return NextResponse.json({ error: info.message, code: info.code }, { status: 422 });
  }

  // Source hash now includes the transcript (Phase 5) so a changed
  // transcript — a better manual paste, newly-available captions —
  // correctly invalidates a cached quiz instead of serving a stale one.
  const sourceHash = buildSourceHash({ kind: "video-quiz", title, description, summary, text: transcript, language });

  let cachedQuiz;
  if (ownerId && playlistId && videoId) {
    cachedQuiz = await getPersonalVideoQuiz(ownerId, playlistId, videoId).catch(() => null);
  } else if (playlistId && videoId) {
    cachedQuiz = await getSharedVideoQuiz(playlistId, videoId).catch(() => null);
  }

  if (cachedQuiz && cachedQuiz.sourceHash === sourceHash) {
    return NextResponse.json({ questions: cachedQuiz.questions }, { headers: { "Cache-Control": "private, no-store" } });
  }

  try {
    const questions = await withAiConnection(uid, async (apiKey, provider, model) => {
      return await generateVideoQuiz(
        { provider, apiKey, model, language },
        { title, description, transcript: transcript || undefined, summary }
      );
    });

    // The cache saves provider cost on later requests, but it must never
    // prevent a learner from receiving a quiz that was generated
    // successfully. In particular, a newly deployed Firestore rule/index
    // or a transient database failure should degrade to an uncached quiz,
    // not a misleading 500 response.
    try {
      if (ownerId && playlistId && videoId) {
        await savePersonalVideoQuiz(ownerId, playlistId, videoId, questions, sourceHash);
      } else if (playlistId && videoId) {
        await saveSharedVideoQuiz(playlistId, videoId, questions, sourceHash);
      }
    } catch (cacheError) {
      logServerError("Generated quiz could not be cached", cacheError);
    }

    return NextResponse.json({ questions }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: unknown) {
    return aiErrorResponse(err, { fallbackMessage: "Something went wrong generating a quiz.", logLabel: "Unexpected error generating AI quiz" });
  }
});
