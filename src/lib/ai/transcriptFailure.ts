import type { TranscriptFailureReason } from "./universalTranscript";

export type TranscriptErrorCode = "transcript_blocked" | "transcript_missing" | "transcript_unavailable";

export interface TranscriptErrorInfo {
  code: TranscriptErrorCode;
  message: string;
}

/** Honest 422 copy shared by POST /api/ai/summary and /api/ai/quiz/generate. */
export function transcriptErrorInfo(reason: TranscriptFailureReason | null | undefined): TranscriptErrorInfo {
  switch (reason) {
    case "blocked":
      return {
        code: "transcript_blocked",
        message: "YouTube blocked automatic caption fetching from the server. Paste the transcript below to continue.",
      };
    case "no_captions":
      return {
        code: "transcript_missing",
        message: "This video has no captions. Paste the transcript below to continue.",
      };
    default:
      return {
        code: "transcript_unavailable",
        message: "Couldn't get the transcript for this video. Paste it below to continue.",
      };
  }
}
