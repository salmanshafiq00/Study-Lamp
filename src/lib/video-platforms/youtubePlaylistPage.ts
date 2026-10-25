import type { ExternalPlaylistVideo } from "./playlist";
import { parseDurationText } from "./youtubeDurationFallback";

/**
 * Public-page fallback for YouTube playlist imports.
 *
 * The official Data API path (used by YouTubePlaylistProvider) needs
 * YOUTUBE_API_KEY and burns quota. When the key is missing, invalid,
 * restricted to the wrong API, or the daily quota is exhausted, the playlist
 * itself is still public — so we read the same data the playlist page renders
 * (ytInitialData) and follow its continuation tokens for playlists over 100
 * videos.
 *
 * This is deliberately a fallback, not the primary path: YouTube can change
 * its page shape at any time, and durations are only available from the Data
 * API. If the page changes shape we throw a clear error instead of returning
 * a partial/incorrect playlist.
 */

const YOUTUBE_ORIGIN = "https://www.youtube.com";
const PAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const PAGE_HEADERS: Record<string, string> = {
  "User-Agent": PAGE_USER_AGENT,
  "Accept-Language": "en-US,en;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  // Avoid YouTube's EU consent interstitial, which would otherwise replace
  // the playlist page with a consent form that has no ytInitialData.
  "Cookie": "CONSENT=YES+cb.20240101-00-p0.en+FX+000",
};

const MAX_CONTINUATION_PAGES = 20;

export interface YouTubePlaylistPageData {
  title: string;
  description: string;
  thumbnailUrl: string;
  totalVideos: number;
  videos: ExternalPlaylistVideo[];
}

interface InnertubeConfig {
  apiKey: string;
  clientVersion: string;
}

/** Extracts the first JSON object/array that follows `marker` in an HTML
 *  document. Uses brace counting (string-aware) instead of a greedy regex,
 *  because ytInitialData is followed by other scripts on the page. */
export function extractJsonAfterMarker(html: string, marker: string): unknown | null {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;

  let start = markerIndex + marker.length;
  while (start < html.length && /\s/.test(html[start])) start += 1;
  if (html[start] !== "{" && html[start] !== "[") return null;

  const open = html[start];
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < html.length; i += 1) {
    const char = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function textFromRuns(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.content === "string") return record.content;
  if (typeof record.simpleText === "string") return record.simpleText;
  if (Array.isArray(record.runs)) {
    return record.runs
      .map((run) => (run && typeof run === "object" && typeof (run as { text?: unknown }).text === "string"
        ? (run as { text: string }).text
        : ""))
      .join("")
      .trim();
  }
  return "";
}

function bestThumbnail(sources: unknown): string {
  if (!Array.isArray(sources)) return "";
  const urls = sources
    .map((source) => (source && typeof source === "object" && typeof (source as { url?: unknown }).url === "string"
      ? (source as { url: string }).url
      : ""))
    .filter((url) => /^https?:\/\//i.test(url));
  // YouTube orders thumbnail sources smallest -> largest, but be defensive:
  // the last valid URL is the best one in the page payloads we have seen.
  return urls.length > 0 ? urls[urls.length - 1] : "";
}

function videoFromLockup(lockup: Record<string, unknown>, order: number): ExternalPlaylistVideo | null {
  const contentId = typeof lockup.contentId === "string" ? lockup.contentId : "";
  const contentType = typeof lockup.contentType === "string" ? lockup.contentType : "";
  if (!contentId || (contentType && !contentType.includes("VIDEO"))) return null;

  const metadata = lockup.metadata as Record<string, unknown> | undefined;
  const lockupMetadata = metadata?.lockupMetadataViewModel as Record<string, unknown> | undefined;
  const title = textFromRuns(lockupMetadata?.title) || "Untitled video";
  if (title === "Deleted video" || title === "Private video") return null;

  const contentImage = lockup.contentImage as Record<string, unknown> | undefined;
  const thumbnailViewModel = contentImage?.thumbnailViewModel as Record<string, unknown> | undefined;
  const image = thumbnailViewModel?.image as Record<string, unknown> | undefined;
  const thumbnailUrl = bestThumbnail(image?.sources);

  return {
    title,
    videoUrl: `${YOUTUBE_ORIGIN}/watch?v=${contentId}`,
    youtubeVideoId: contentId,
    thumbnailUrl: thumbnailUrl || `https://i.ytimg.com/vi/${contentId}/hqdefault.jpg`,
    durationSeconds: durationFromLockup(thumbnailViewModel),
    description: null,
    creator: null,
    publishedAt: null,
    platform: "youtube",
    order,
  };
}

/** The playlist page draws duration as a badge on the thumbnail ("6:34",
 *  "1:02:03"). Reading it here means imports need no per-video duration calls.
 *  Returns undefined when the badge is absent or says "LIVE"/"NEW". */
function durationFromLockup(thumbnailViewModel: Record<string, unknown> | undefined): number | undefined {
  const overlays = thumbnailViewModel?.overlays as unknown;
  if (!Array.isArray(overlays)) return undefined;

  for (const overlay of overlays) {
    const bottom = (overlay as Record<string, unknown> | undefined)?.thumbnailBottomOverlayViewModel as
      | Record<string, unknown>
      | undefined;
    const badges = bottom?.badges as unknown;
    if (!Array.isArray(badges)) continue;
    for (const badge of badges) {
      const text = ((badge as Record<string, unknown> | undefined)?.thumbnailBadgeViewModel as
        | Record<string, unknown>
        | undefined)?.text;
      const seconds = parseDurationText(typeof text === "string" ? text : null);
      if (seconds !== null) return seconds;
    }
  }
  return undefined;
}

function videoFromPlaylistVideoRenderer(renderer: Record<string, unknown>, order: number): ExternalPlaylistVideo | null {
  const videoId = typeof renderer.videoId === "string" ? renderer.videoId : "";
  if (!videoId) return null;
  const title = textFromRuns(renderer.title) || "Untitled video";
  if (title === "Deleted video" || title === "Private video") return null;
  const thumbnail = renderer.thumbnail as Record<string, unknown> | undefined;
  const thumbnailUrl = bestThumbnail(thumbnail?.thumbnails);
  return {
    title,
    videoUrl: `${YOUTUBE_ORIGIN}/watch?v=${videoId}`,
    youtubeVideoId: videoId,
    thumbnailUrl: thumbnailUrl || `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: parseDurationText(textFromRuns(renderer.lengthText)) ?? undefined,
    description: null,
    creator: null,
    publishedAt: null,
    platform: "youtube",
    order,
  };
}

/** Walks any ytInitialData/continuation payload and returns every playlist
 *  video it can find. Kept generic so the same function handles the modern
 *  lockupViewModel shape and the older playlistVideoRenderer shape. */
export function collectPlaylistPageVideos(payload: unknown, startOrder = 0): ExternalPlaylistVideo[] {
  const videos: ExternalPlaylistVideo[] = [];
  const seen = new Set<string>();
  const visited = new Set<unknown>();

  function push(video: ExternalPlaylistVideo | null) {
    if (!video || !video.youtubeVideoId || seen.has(video.youtubeVideoId)) return;
    seen.add(video.youtubeVideoId);
    videos.push({ ...video, order: startOrder + videos.length });
  }

  function visit(value: unknown) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = value as Record<string, unknown>;
    if (record.lockupViewModel && typeof record.lockupViewModel === "object") {
      push(videoFromLockup(record.lockupViewModel as Record<string, unknown>, videos.length));
    }
    if (record.playlistVideoRenderer && typeof record.playlistVideoRenderer === "object") {
      push(videoFromPlaylistVideoRenderer(record.playlistVideoRenderer as Record<string, unknown>, videos.length));
    }

    Object.values(record).forEach(visit);
  }

  visit(payload);
  return videos;
}

/** Finds continuation tokens in either the initial page payload or a
 *  continued response. Returns only tokens that continue a playlist. */
export function collectContinuationTokens(payload: unknown): string[] {
  const tokens: string[] = [];
  const visited = new Set<unknown>();

  function visit(value: unknown) {
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);

    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }

    const record = value as Record<string, unknown>;

    const continuationItem = record.continuationItemViewModel as Record<string, unknown> | undefined;
    const innertubeCommand = continuationItem?.continuationCommand as Record<string, unknown> | undefined;
    const nestedCommand = innertubeCommand?.innertubeCommand as Record<string, unknown> | undefined;
    const command = nestedCommand?.continuationCommand as Record<string, unknown> | undefined;
    if (typeof command?.token === "string") tokens.push(command.token);

    const continuationEndpoint = record.continuationEndpoint as Record<string, unknown> | undefined;
    const endpointCommand = continuationEndpoint?.continuationCommand as Record<string, unknown> | undefined;
    if (typeof endpointCommand?.token === "string") tokens.push(endpointCommand.token);

    const directContinuation = record.continuationCommand as Record<string, unknown> | undefined;
    if (typeof directContinuation?.token === "string") tokens.push(directContinuation.token);

    Object.values(record).forEach(visit);
  }

  visit(payload);
  return Array.from(new Set(tokens));
}

function readInnertubeConfig(html: string): InnertubeConfig | null {
  const apiKey = /"INNERTUBE_API_KEY":"([^"]+)"/.exec(html)?.[1];
  const clientVersion = /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1];
  return apiKey && clientVersion ? { apiKey, clientVersion } : null;
}

function readPlaylistMetadata(payload: unknown) {
  const data = payload as Record<string, unknown> | null;
  const metadataRenderer = (data?.metadata as Record<string, unknown> | undefined)?.playlistMetadataRenderer as
    | Record<string, unknown>
    | undefined;

  const sidebarItems = (data?.sidebar as Record<string, unknown> | undefined)?.playlistSidebarRenderer as
    | Record<string, unknown>
    | undefined;
  const sidebarItemList = Array.isArray(sidebarItems?.items) ? sidebarItems?.items : [];
  const primary = (sidebarItemList[0] as Record<string, unknown> | undefined)?.playlistSidebarPrimaryInfoRenderer as
    | Record<string, unknown>
    | undefined;

  const title = String(
    metadataRenderer?.title ??
    textFromRuns(primary?.title) ??
    "Imported playlist"
  ).trim() || "Imported playlist";
  const description = String(metadataRenderer?.description ?? "").trim();

  const thumbnailRenderer = primary?.thumbnailRenderer as Record<string, unknown> | undefined;
  const playlistThumbnail = thumbnailRenderer?.playlistVideoThumbnailRenderer as Record<string, unknown> | undefined;
  const thumbnail = playlistThumbnail?.thumbnail as Record<string, unknown> | undefined;
  const thumbnailUrl = bestThumbnail(thumbnail?.thumbnails);

  let totalVideos = 0;
  const stats = Array.isArray(primary?.stats) ? primary?.stats : [];
  for (const stat of stats) {
    const count = textFromRuns((stat as Record<string, unknown> | undefined)?.runs);
    const numeric = Number(count.replace(/[^\d]/g, ""));
    if (Number.isFinite(numeric) && numeric > 0) {
      totalVideos = numeric;
      break;
    }
  }

  return { title, description, thumbnailUrl, totalVideos };
}

async function fetchPage(playlistId: string): Promise<{ html: string; data: unknown }> {
  const url = `${YOUTUBE_ORIGIN}/playlist?list=${encodeURIComponent(playlistId)}&hl=en`;
  const res = await fetch(url, {
    headers: PAGE_HEADERS,
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    throw new Error(`YouTube returned HTTP ${res.status} for this playlist.`);
  }
  const html = await res.text();
  const data = extractJsonAfterMarker(html, "var ytInitialData =") ?? extractJsonAfterMarker(html, "ytInitialData =");
  if (!data) {
    throw new Error("YouTube did not return a readable playlist page. The playlist may be private or unavailable.");
  }
  return { html, data };
}

async function fetchContinuation(
  token: string,
  config: InnertubeConfig,
): Promise<unknown | null> {
  const url = `${YOUTUBE_ORIGIN}/youtubei/v1/browse?key=${encodeURIComponent(config.apiKey)}&prettyPrint=false`;
  const body = {
    context: {
      client: {
        clientName: "WEB",
        clientVersion: config.clientVersion,
        hl: "en",
        gl: "US",
      },
    },
    continuation: token,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": PAGE_USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
      "Cookie": PAGE_HEADERS.Cookie,
    },
    body: JSON.stringify(body),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/** Fetches a public playlist without the YouTube Data API. Throws with a
 *  user-readable message when the playlist is private/unavailable or the page
 *  shape changed enough that no videos could be read. */
export async function fetchYouTubePlaylistPage(playlistId: string): Promise<YouTubePlaylistPageData> {
  const { html, data } = await fetchPage(playlistId);
  const metadata = readPlaylistMetadata(data);

  let videos = collectPlaylistPageVideos(data);
  if (videos.length === 0) {
    throw new Error("YouTube did not expose any videos for this playlist. It may be private or region-restricted.");
  }

  const config = readInnertubeConfig(html);
  let tokens = collectContinuationTokens(data);
  const seenTokens = new Set<string>();
  let pages = 0;

  while (config && tokens.length > 0 && pages < MAX_CONTINUATION_PAGES) {
    const token = tokens.shift() as string;
    if (seenTokens.has(token)) continue;
    seenTokens.add(token);
    pages += 1;

    const next = await fetchContinuation(token, config);
    if (!next) break;

    const nextVideos = collectPlaylistPageVideos(next);
    const existingIds = new Set(videos.map((video) => video.youtubeVideoId));
    for (const video of nextVideos) {
      if (video.youtubeVideoId && !existingIds.has(video.youtubeVideoId)) {
        videos.push({ ...video, order: videos.length });
      }
    }

    tokens = collectContinuationTokens(next).filter((nextToken) => !seenTokens.has(nextToken));
  }

  const totalVideos = Math.max(metadata.totalVideos, videos.length);
  return {
    title: metadata.title,
    description: metadata.description,
    thumbnailUrl: metadata.thumbnailUrl || videos[0]?.thumbnailUrl || "",
    totalVideos,
    videos,
  };
}
