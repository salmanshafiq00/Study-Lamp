import type { QuizQuestion } from "@/types";
import type { AiLanguage } from "@/lib/ai/types";
import { toast } from "sonner";
import { apiErrorFromResponse, readApiResponseBody } from "@/lib/apiError";
import { buildQuizAttemptBody, type QuizAttemptPayload } from "@/lib/quizAttempt";

export interface GenerateQuizInput {
  language?: AiLanguage;
  youtubeVideoId?: string;
  /** Phase 4 (roadmap v3): a manually pasted/uploaded transcript, used when
   *  there's no YouTube video (or no captions) to fall back on. */
  manualTranscript?: string;
  videoId?: string;
  playlistId?: string;
  ownerId?: string;
  title?: string;
  description?: string | null;
  summary?: string | null;
}

export async function generateVideoQuizForCurrentVideo(
  idToken: string,
  input: GenerateQuizInput,
): Promise<{ questions: QuizQuestion[] }> {
  const res = await fetch("/api/ai/quiz/generate", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${idToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  const data = await readApiResponseBody(res);
  if (!res.ok) throw apiErrorFromResponse(res, data);
  return { questions: Array.isArray(data.questions) ? (data.questions as QuizQuestion[]) : [] };
}

/**
 * Saves a finished quiz attempt. Never throws into the UI: any failure (network, non-2xx)
 * shows one toast and resolves to false.
 */
export async function submitQuizAttempt(
  user: { getIdToken: () => Promise<string> },
  payload: QuizAttemptPayload,
): Promise<boolean> {
  try {
    const idToken = await user.getIdToken();
    const response = await fetch("/api/quiz-attempts", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${idToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildQuizAttemptBody(payload)),
    });
    if (!response.ok) {
      toast.error("Couldn't save your quiz result");
      return false;
    }
    return true;
  } catch {
    toast.error("Couldn't save your quiz result");
    return false;
  }
}
