// Thin client-side wrapper around POST /api/ai/summary — same fetch +
// Bearer-token pattern as src/lib/aiConnectionsClient.ts. Deliberately just
// one function: unlike AI connections, there's only one thing a video page
// needs to do here.
import type { AiLanguage } from "@/lib/ai/types";
import { ApiRequestError, apiErrorFromResponse, readApiResponseBody } from "@/lib/apiError";

async function parseOrThrow(res: Response): Promise<Record<string, unknown>> {
  const data = await readApiResponseBody(res);
  if (!res.ok) throw apiErrorFromResponse(res, data);
  return data;
}

export interface GenerateStarterSummaryInput {
  language?: AiLanguage;
  youtubeVideoId?: string;
  /** Phase 4 (roadmap v3): a manually pasted/uploaded transcript, used when
   *  there's no YouTube video (or no captions) to fall back on. */
  manualTranscript?: string;
}

export async function generateStarterSummary(
  idToken: string,
  input: GenerateStarterSummaryInput
): Promise<string> {
  const res = await fetch("/api/ai/summary", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const data = await parseOrThrow(res);
  if (typeof data.summary !== "string") {
    throw new ApiRequestError("Something went wrong generating a summary.");
  }
  return data.summary;
}
