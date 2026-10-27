import { fetchTranscript } from "youtube-transcript";
import { logServerError } from "@/lib/server/logError";

const MAX_TRANSCRIPT_CHARS = 60_000;

export class TranscriptUnavailableError extends Error {
  constructor(message = "No YouTube transcript is available for this video.") {
    super(message);
    this.name = "TranscriptUnavailableError";
  }
}

export function cleanTranscript(text: string): string {
  return text
    .replace(/\[music\]|\[applause\]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

export async function getYouTubeTranscript(videoId: string): Promise<string> {
  try {
    const entries = await fetchTranscript(videoId);
    const transcript = cleanTranscript(entries.map((entry) => entry.text || "").join(" "));
    if (!transcript) throw new TranscriptUnavailableError();
    return transcript.slice(0, MAX_TRANSCRIPT_CHARS);
  } catch (error) {
    if (error instanceof TranscriptUnavailableError) throw error;
    logServerError("YouTube transcript fetch failed", error);
    console.error(
      "YouTube transcript detail:",
      error instanceof Error ? error.message.slice(0, 200) : "non-error",
      error instanceof Error && error.cause instanceof Error ? error.cause.message.slice(0, 200) : ""
    );
    try {
      const res = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
        headers: { "Accept-Language": "en-US,en;q=0.9" },
      });
      const html = await res.text();
      console.error(
        "YT diag",
        res.status,
        html.length,
        "captions:", html.includes('"captions":'),
        "recaptcha:", html.includes("g-recaptcha"),
        "consent:", html.includes("consent.youtube.com"),
        "botcheck:", /confirm you.re not a bot/i.test(html)
      );
    } catch {
      console.error("YT diag fetch failed");
    }
    throw new TranscriptUnavailableError();
  }
}
