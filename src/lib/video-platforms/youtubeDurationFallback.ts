/**
 * Keyless duration lookup for YouTube videos.
 *
 * The official Data API is still the primary source (`videos.list` with
 * `contentDetails.duration`), but it fails for reasons that have nothing to do
 * with the video: no `YOUTUBE_API_KEY`, a key restricted by HTTP referrer
 * ("Requests from referer <empty> are blocked"), a key restricted to a
 * different API, or an exhausted quota. Durations are also missing for every
 * video imported through the public-playlist fallback.
 *
 * YouTube's own web client fetches the same number from the InnerTube player
 * endpoint (`videoDetails.lengthSeconds`). That endpoint accepts a normal
 * browser request without an API key, which makes it a reliable fallback.
 * It is deliberately best-effort: private, deleted, or region-blocked videos
 * simply have no duration to return.
 */

const PLAYER_URL = "https://www.youtube.com/youtubei/v1/player?prettyPrint=false";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// The endpoint ignores the exact version for this use case (only videoDetails
// is read), so pin a stable one instead of scraping it from a page first.
const CLIENT_VERSION = "2.20250101.00.00";
const DEFAULT_CONCURRENCY = 6;

/** Parses the display durations YouTube puts on thumbnails/legacy renderers:
 *  "6:34" -> 394, "1:02:03" -> 3723. Returns null for anything else ("LIVE",
 *  "NEW", empty, malformed). */
export function parseDurationText(value: string | null | undefined): number | null {
  if (!value) return null;
  const text = value.trim();
  if (!/^\d{1,3}(?::\d{1,2}){1,2}$/.test(text)) return null;
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return seconds > 0 ? seconds : null;
}

/** Reads `videoDetails.lengthSeconds` from an InnerTube player response. */
export function extractLengthSecondsFromPlayerJson(payload: unknown): number | null {
  if (!payload || typeof payload !== "object") return null;
  const details = (payload as { videoDetails?: { lengthSeconds?: unknown } }).videoDetails;
  const raw = details?.lengthSeconds;
  const seconds = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
}

async function fetchPlayerDuration(videoId: string): Promise<{ seconds: number | null; error: string | null }> {
  try {
    const res = await fetch(PLAYER_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": USER_AGENT,
        "Accept-Language": "en-US,en;q=0.9",
        Origin: "https://www.youtube.com",
        Cookie: "CONSENT=YES+cb.20240101-00-p0.en+FX+000",
      },
      body: JSON.stringify({
        context: { client: { clientName: "WEB", clientVersion: CLIENT_VERSION, hl: "en", gl: "US" } },
        videoId,
      }),
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { seconds: null, error: `YouTube returned HTTP ${res.status}.` };
    const data = await res.json().catch(() => null);
    return { seconds: extractLengthSecondsFromPlayerJson(data), error: null };
  } catch (error) {
    return { seconds: null, error: error instanceof Error ? error.message : "Network error contacting YouTube." };
  }
}

async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (true) {
        const index = next;
        next += 1;
        if (index >= items.length) return;
        await run(items[index]);
      }
    }),
  );
}

/** Looks up durations for the given video IDs without any API key. Never
 *  throws; returns whatever it could resolve plus the first transport error
 *  (if any) so callers can explain a partial result. */
export async function fetchYouTubeDurationsFromYouTube(
  videoIds: string[],
  options: { concurrency?: number } = {},
): Promise<{ durations: Record<string, number>; error: string | null }> {
  const ids = Array.from(new Set(videoIds.filter(Boolean)));
  const durations: Record<string, number> = {};
  let firstError: string | null = null;

  await mapWithConcurrency(ids, options.concurrency ?? DEFAULT_CONCURRENCY, async (videoId) => {
    const { seconds, error } = await fetchPlayerDuration(videoId);
    if (seconds !== null) durations[videoId] = seconds;
    else if (error && !firstError) firstError = error;
  });

  if (ids.length > 0 && Object.keys(durations).length === 0 && !firstError) {
    firstError = "YouTube did not return durations for these videos.";
  }

  return { durations, error: firstError };
}
