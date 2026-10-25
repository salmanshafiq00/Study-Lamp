/**
 * YouTube's public oEmbed endpoint (used for single-video "paste a URL"
 * metadata) and the playlistItems API (used for playlist import) both omit
 * video duration — it only exists on the separate `videos` resource's
 * `contentDetails.duration` field (ISO 8601, e.g. "PT15M33S"), which
 * requires the official Data API v3 and an API key. This is server-only.
 *
 * When the Data API cannot answer (missing key, referrer-restricted key,
 * quota exhausted, API not enabled), `youtubeDurationFallback` reads the same
 * number from YouTube's player response, so durations still work.
 */

import { fetchYouTubeDurationsFromYouTube } from "./youtubeDurationFallback";

export function parseIso8601Duration(iso: string): number | null {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!match) return null;
  const hours = Number(match[1] || 0);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? total : (iso === "PT0S" ? 0 : null);
}

export interface YouTubeDurationLookupOptions {
  /** Origin/full URL sent as `Referer` to the Data API. Needed when the key is
   *  restricted by HTTP referrer and the server would otherwise send none
   *  ("Requests from referer <empty> are blocked"). */
  referer?: string | null;
}

// Video durations never change, so successful lookups are cached for the
// lifetime of the server instance. This makes repeated "fix durations" runs
// (and the single-video add flow) cheap.
const durationCache = new Map<string, number>();
const CACHE_LIMIT = 5000;

function normalizeReferer(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return `${url.origin}/`;
  } catch {
    return null;
  }
}

function refererFromOptions(options: YouTubeDurationLookupOptions): string | null {
  return normalizeReferer(options.referer) ?? normalizeReferer(process.env.YOUTUBE_API_REFERER);
}

async function fetchViaDataApi(
  videoIds: string[],
  apiKey: string,
  referer: string | null,
): Promise<{ durations: Record<string, number>; error: string | null }> {
  const durations: Record<string, number> = {};
  let error: string | null = null;

  for (let start = 0; start < videoIds.length; start += 50) {
    const batch = videoIds.slice(start, start + 50);
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "contentDetails");
    url.searchParams.set("id", batch.join(","));
    url.searchParams.set("key", apiKey);

    try {
      const res = await fetch(url.toString(), {
        cache: "no-store",
        headers: referer ? { Referer: referer } : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        error = data?.error?.message || `YouTube API request failed (${res.status})`;
        continue;
      }
      (data.items || []).forEach((item: any) => {
        const seconds = item?.contentDetails?.duration ? parseIso8601Duration(item.contentDetails.duration) : null;
        if (item?.id && seconds !== null) durations[item.id] = seconds;
      });
    } catch (e: any) {
      error = e?.message || "Network error contacting the YouTube Data API";
    }
  }

  return { durations, error };
}

/** Batches requests in groups of 50 (the YouTube Data API's per-request id
 *  limit). Returns whatever succeeded plus the last error encountered, so
 *  callers can show the *actual* reason (bad key, quota, API not enabled,
 *  referrer restriction, etc.) instead of a generic guess. */
export async function fetchYouTubeDurations(
  videoIds: string[],
  options: YouTubeDurationLookupOptions = {},
): Promise<{ durations: Record<string, number>; error: string | null }> {
  if (videoIds.length === 0) return { durations: {}, error: null };

  const uniqueIds = Array.from(new Set(videoIds.filter(Boolean)));
  const durations: Record<string, number> = {};
  const toLookup: string[] = [];

  for (const id of uniqueIds) {
    const cached = durationCache.get(id);
    if (cached !== undefined) durations[id] = cached;
    else toLookup.push(id);
  }

  let error: string | null = null;

  if (toLookup.length > 0) {
    const apiKey = process.env.YOUTUBE_API_KEY;
    if (apiKey) {
      const api = await fetchViaDataApi(toLookup, apiKey, refererFromOptions(options));
      Object.assign(durations, api.durations);
      error = api.error;
    } else {
      error = "YOUTUBE_API_KEY is not set on the server.";
    }

    const stillMissing = toLookup.filter((id) => durations[id] === undefined);
    if (stillMissing.length > 0) {
      // Keyless fallback. Also covers videos imported through the public
      // playlist page, which never had a Data API entry to begin with.
      const fallback = await fetchYouTubeDurationsFromYouTube(stillMissing);
      Object.assign(durations, fallback.durations);
      if (fallback.error) {
        error = error ? `${error} (fallback: ${fallback.error})` : fallback.error;
      }
    }

    if (toLookup.every((id) => durations[id] !== undefined)) {
      // Every requested video resolved even if the Data API complained.
      error = null;
    }
  }

  if (durationCache.size > CACHE_LIMIT) durationCache.clear();
  for (const [id, seconds] of Object.entries(durations)) durationCache.set(id, seconds);

  return { durations, error };
}
