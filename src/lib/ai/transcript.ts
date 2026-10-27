import { fetchTranscript } from "youtube-transcript";
import { logServerError } from "@/lib/server/logError";
import { MAX_TRANSCRIPT_CHARS } from "./transcriptLimits";

const WATCH_PAGE_TIMEOUT_MS = 4_000;
const WATCH_PAGE_HEADERS = { "Accept-Language": "en-US,en;q=0.9" };

export type TranscriptFailureReason = "blocked" | "no_captions" | "unavailable" | "unknown";

export class TranscriptUnavailableError extends Error {
  readonly reason?: TranscriptFailureReason;

  constructor(message = "No YouTube transcript is available for this video.", reason?: TranscriptFailureReason) {
    super(message);
    this.name = "TranscriptUnavailableError";
    this.reason = reason;
  }
}

export function cleanTranscript(text: string): string {
  return text
    .replace(/\[music\]|\[applause\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function errorText(error: unknown): string {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  return typeof error === "string" ? error : "";
}

/**
 * Maps a youtube-transcript error to a reason we can tell the learner.
 *
 * "disabled" / "not available" are deliberately NOT mapped to "no_captions":
 * YouTube's bot-check page has no captions section, so the library reports
 * "Transcript is disabled" for a video that does have captions. Those cases
 * come back as "unknown" and are refined by classifyWatchPageHtml().
 */
export function classifyYouTubeFailure(error: unknown): TranscriptFailureReason {
  const text = errorText(error);
  if (/toomanyrequests?|too.?many.?requests?|captcha|recaptcha/i.test(text)) return "blocked";
  if (/videounavailable|video is no longer available|video unavailable|not found|does not exist/i.test(text)) {
    return "unavailable";
  }
  return "unknown";
}

/** True for the library errors whose meaning depends on what the watch page actually contains. */
export function isAmbiguousYouTubeFailure(error: unknown): boolean {
  return /transcript is disabled|disabled on this video|no transcripts are available|notavailable|not available/i.test(
    errorText(error)
  );
}

export function classifyWatchPageHtml(
  html: string,
): "blocked" | "has_captions" | "no_captions" | "unknown" {
  if (/LOGIN_REQUIRED|g-recaptcha|confirm you['’]re not a bot/i.test(html)) return "blocked";

  if (/["']captions["']\s*:/.test(html)) return "has_captions";

  if (/"playabilityStatus"\s*:\s*\{[^}]*"status"\s*:\s*"OK"/.test(html)) return "no_captions";

  return "unknown";
}

async function fetchWatchPageHtml(videoId: string): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), WATCH_PAGE_TIMEOUT_MS);
  try {
    const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`, {
      headers: WATCH_PAGE_HEADERS,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function getYouTubeTranscript(videoId: string): Promise<string> {
  try {
    const entries = await fetchTranscript(videoId);
    const transcript = cleanTranscript(entries.map((entry) => entry.text || "").join(" "));
    if (!transcript) throw new TranscriptUnavailableError(undefined, "no_captions");
    return transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  } catch (error) {
    if (error instanceof TranscriptUnavailableError) throw error;
    logServerError("YouTube transcript fetch failed", error);

    let reason = classifyYouTubeFailure(error);
    if (isAmbiguousYouTubeFailure(error)) {
      // Only on this failure path: look at the page once to tell a real
      // "no captions" video apart from YouTube's datacenter/bot-check page.
      // The HTML is never logged.
      const html = await fetchWatchPageHtml(videoId);
      const page = html ? classifyWatchPageHtml(html) : "unknown";
      reason = page === "has_captions" ? "unknown" : page;
    }

    throw new TranscriptUnavailableError(undefined, reason);
  }
}
