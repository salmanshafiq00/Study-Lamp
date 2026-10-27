import { NextResponse } from "next/server";
import { generateVideoSummary } from "@/lib/ai/aiService";
import { resolveTranscriptDetailed } from "@/lib/ai/universalTranscript";
import { transcriptErrorInfo } from "@/lib/ai/transcriptFailure";
import { AiServiceError } from "@/lib/ai/errors";
import { transcribeYouTubeWithGemini } from "@/lib/ai/providers/gemini";
import { resolveAiLanguage } from "@/lib/server/aiPreferences";
import { getPreferredAiProvider, withAiConnection } from "@/lib/server/resolveAiConnection";
import { aiErrorResponse, withAuthedRoute } from "@/lib/server/routeHelpers";

const TRANSCRIPT_MAX_LENGTH = 50000;

const TITLE_MAX_LENGTH = 300;
const DESCRIPTION_MAX_LENGTH = 5000;

// POST /api/ai/summary — generate a transcript-backed summary draft.
// Body: { title, description?, youtubeVideoId?, manualTranscript? }.
// Phase 4 (roadmap v3): youtubeVideoId is no longer the only way in — a
// non-YouTube video can send its saved manualTranscript (from
// users/{uid}/transcripts/{videoId} — see src/lib/firestore/transcripts.ts)
// instead. resolveTranscriptDetailed() prefers a saved/pasted manual
// transcript, then YouTube captions, then the optional Gemini-from-URL
// fallback (Gemini fetches the public video itself, so it is not affected by
// YouTube blocking our server IP).
// Returns { summary: string }. Does NOT touch Firestore's summary
// collection — the caller is responsible for putting the returned text into
// the existing summary textarea/state and saving it via the existing
// save/autosave path (see src/app/video/[videoId]/page.tsx).
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
  if (b.title !== undefined && typeof b.title !== "string") {
    return NextResponse.json({ error: "title must be a string when provided." }, { status: 400 });
  }
  if (typeof b.title === "string" && b.title.length > TITLE_MAX_LENGTH) {
    return NextResponse.json({ error: "title is too long." }, { status: 400 });
  }
  if (b.description !== undefined && b.description !== null) {
    if (typeof b.description !== "string") {
      return NextResponse.json({ error: "description must be a string." }, { status: 400 });
    }
    if (b.description.length > DESCRIPTION_MAX_LENGTH) {
      return NextResponse.json({ error: "description is too long." }, { status: 400 });
    }
  }
  const youtubeVideoId = typeof b.youtubeVideoId === "string" ? b.youtubeVideoId.trim() : "";
  const manualTranscript = typeof b.manualTranscript === "string" ? b.manualTranscript : "";
  const language = await resolveAiLanguage(uid, b.language);
  if (!language) return NextResponse.json({ error: "language must be en or bn." }, { status: 400 });
  if (manualTranscript.length > TRANSCRIPT_MAX_LENGTH) {
    return NextResponse.json({ error: "manualTranscript is too long." }, { status: 400 });
  }
  if (!youtubeVideoId && !manualTranscript.trim()) {
    return NextResponse.json(
      { error: "A YouTube video, or a pasted/uploaded transcript, is required for transcript-based summaries." },
      { status: 400 }
    );
  }

  const preferredProvider = await getPreferredAiProvider(uid).catch(() => null);
  const transcriptResult = await resolveTranscriptDetailed(
    { youtubeVideoId, manualTranscript },
    preferredProvider === "gemini"
      ? {
          geminiFallback: (videoId: string) =>
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
                return await transcribeYouTubeWithGemini({ provider, apiKey, model }, videoId);
              } catch (err) {
                if (err instanceof AiServiceError && err.code === "unknown") throw err;
                throw new AiServiceError("unknown", err instanceof Error ? err.message : "Transcription failed.");
              }
            }),
        }
      : undefined
  );
  const transcript = transcriptResult.text;
  if (!transcript) {
    const info = transcriptErrorInfo(transcriptResult.failureReason);
    return NextResponse.json({ error: info.message, code: info.code }, { status: 422 });
  }

  try {
    const title = typeof b.title === "string" ? b.title : undefined;
    const description = b.description === null ? null : typeof b.description === "string" ? b.description : undefined;

    const summary = await withAiConnection(uid, async (apiKey, provider, model) => {
      return await generateVideoSummary(
        { provider, apiKey, model, language },
        { title, description, transcript }
      );
    });

    return NextResponse.json({ summary }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (err: unknown) {
    return aiErrorResponse(err, { fallbackMessage: "Something went wrong generating a summary.", logLabel: "Unexpected error generating AI summary" });
  }
});
