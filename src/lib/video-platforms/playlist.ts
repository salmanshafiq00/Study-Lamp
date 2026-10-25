import type { VideoPlatform } from "@/types";
import { parseVideoUrl } from "./types";
import { fetchYouTubeDurations } from "./youtubeDuration";
import { fetchYouTubePlaylistPage } from "./youtubePlaylistPage";
import { extractFacebookCollectionId, fetchFacebookCollection } from "./facebookGraph";

// Extend this union (and register a new ExternalPlaylistProvider below) to
// add another platform's collection/playlist import — e.g. "vimeo" for
// Vimeo showcases or "tiktok" for TikTok collections. Nothing else in this
// file, the API route, or the "Import Playlist" UI needs to know which
// provider is active; they all dispatch off this list.
export type ExternalPlaylistSourceProvider = "youtube" | "facebook";

export interface ExternalPlaylistVideo {
  title: string;
  videoUrl: string;
  youtubeVideoId?: string | null;
  thumbnailUrl: string;
  durationSeconds?: number;
  description?: string | null;
  creator?: string | null;
  publishedAt?: string | null;
  platform: VideoPlatform;
  order: number;
}

export interface ExternalPlaylistPreview {
  provider: ExternalPlaylistSourceProvider;
  title: string;
  description?: string | null;
  thumbnailUrl?: string | null;
  sourceUrl: string;
  totalVideos: number;
  unavailableCount: number;
  videos: ExternalPlaylistVideo[];
}

export interface ExternalPlaylistProvider {
  provider: ExternalPlaylistSourceProvider;
  detect(url: string): boolean;
  extractPlaylistId(url: string): string | null;
  fetchPreview(url: string, options?: ExternalPlaylistFetchOptions): Promise<ExternalPlaylistPreview>;
}

export interface ExternalPlaylistFetchOptions {
  /** Caller's origin, forwarded to the YouTube Data API as `Referer` because
   *  keys restricted by HTTP referrer reject requests without one. */
  referer?: string;
}

function youtubePlaylistThumbnailUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith("http://") || url.startsWith("https://")) return url;
  return null;
}

export class YouTubePlaylistProvider implements ExternalPlaylistProvider {
  provider: "youtube" = "youtube";

  detect(url: string): boolean {
    const parsed = parseVideoUrl(url);
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase();
    if (!host.includes("youtube.com") && host !== "youtu.be") return false;
    if (parsed.searchParams.get("list")) return true;
    const pathname = parsed.pathname.toLowerCase();
    return pathname.startsWith("/playlist") || pathname.startsWith("/embed/videoseries");
  }

  extractPlaylistId(url: string): string | null {
    const parsed = parseVideoUrl(url);
    if (!parsed) return null;
    const listId = parsed.searchParams.get("list");
    if (listId) return listId;

    const pathname = parsed.pathname;
    const match = pathname.match(/\/playlist\/?$/i) || pathname.match(/\/embed\/videoseries\/?$/i);
    if (match && parsed.searchParams.get("list")) return parsed.searchParams.get("list");
    return null;
  }

  async fetchPreview(url: string, options: ExternalPlaylistFetchOptions = {}): Promise<ExternalPlaylistPreview> {
    const playlistId = this.extractPlaylistId(url);
    if (!playlistId) {
      throw new Error("This does not look like a valid YouTube playlist URL.");
    }

    const apiKey = process.env.YOUTUBE_API_KEY;
    if (!apiKey) {
      return this.fetchViaPublicPage(url, playlistId, "YouTube API key is not configured on the server.");
    }

    try {
      return await this.fetchViaDataApi(url, playlistId, apiKey, options);
    } catch (error) {
      // A missing/expired key, a key restricted to another API, an exhausted
      // quota, or a temporarily unavailable Data API must not block importing
      // a public playlist. The page fallback reads the same playlist (title,
      // videos, and thumbnail durations) without the Data API.
      if (!isDataApiFallbackError(error)) throw error;
      return this.fetchViaPublicPage(
        url,
        playlistId,
        error instanceof Error ? error.message : "YouTube Data API request failed.",
      );
    }
  }

  /**
   * Official Data API path: playlist metadata, every playlistItems page, then
   * durations from videos.list. This is the primary path whenever a key is
   * configured.
   */
  private async fetchViaDataApi(
    url: string,
    playlistId: string,
    apiKey: string,
    options: ExternalPlaylistFetchOptions = {},
  ): Promise<ExternalPlaylistPreview> {
    // A referrer-restricted key rejects server-to-server calls with no
    // Referer header, so forward the caller's origin when we have it.
    const referer = options.referer ? { Referer: options.referer } : undefined;

    const metaUrl = new URL("https://www.googleapis.com/youtube/v3/playlists");
    metaUrl.searchParams.set("part", "snippet,status");
    metaUrl.searchParams.set("id", playlistId);
    metaUrl.searchParams.set("key", apiKey);

    const metaRes = await fetch(metaUrl.toString(), {
      cache: "no-store",
      headers: referer,
      signal: AbortSignal.timeout(15000),
    });
    const metaJson = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok) {
      throw new DataApiFallbackError(
        metaJson?.error?.message || `YouTube API request failed (${metaRes.status}).`,
        metaRes.status,
      );
    }

    const playlistItem = metaJson.items?.[0];
    if (!playlistItem) {
      throw new Error("This playlist could not be found or is unavailable.");
    }

    if (playlistItem.status?.privacyStatus === "private") {
      throw new Error("This YouTube playlist is private and cannot be imported.");
    }

    let pageToken = "";
    const items: any[] = [];
    do {
      const itemsUrl = new URL("https://www.googleapis.com/youtube/v3/playlistItems");
      itemsUrl.searchParams.set("part", "snippet,status,contentDetails");
      itemsUrl.searchParams.set("maxResults", "50");
      itemsUrl.searchParams.set("playlistId", playlistId);
      itemsUrl.searchParams.set("key", apiKey);
      if (pageToken) itemsUrl.searchParams.set("pageToken", pageToken);

      const res = await fetch(itemsUrl.toString(), {
        cache: "no-store",
        headers: referer,
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new DataApiFallbackError(
          data?.error?.message || `YouTube API request failed (${res.status}).`,
          res.status,
        );
      }
      items.push(...(data.items || []));
      pageToken = data.nextPageToken || "";
    } while (pageToken);

    const validVideos: ExternalPlaylistVideo[] = [];
    let unavailableCount = 0;

    items.forEach((item, index) => {
      const title = item?.snippet?.title;
      const videoId = item?.contentDetails?.videoId || item?.snippet?.resourceId?.videoId;
      const status = item?.status?.privacyStatus || "public";

      if (!videoId || status === "private") {
        unavailableCount += 1;
        return;
      }

      if (title === "Deleted video" || title === "Private video") {
        unavailableCount += 1;
        return;
      }

      validVideos.push({
        title: title || "Untitled video",
        videoUrl: `https://www.youtube.com/watch?v=${videoId}`,
        youtubeVideoId: videoId,
        thumbnailUrl:
          youtubePlaylistThumbnailUrl(item?.snippet?.thumbnails?.high?.url) ||
          youtubePlaylistThumbnailUrl(item?.snippet?.thumbnails?.medium?.url) ||
          youtubePlaylistThumbnailUrl(item?.snippet?.thumbnails?.default?.url) ||
          "",
        durationSeconds: undefined,
        description: item?.snippet?.description || null,
        creator: item?.snippet?.videoOwnerChannelTitle || item?.snippet?.channelTitle || null,
        publishedAt: item?.snippet?.publishedAt || item?.contentDetails?.videoPublishedAt || null,
        platform: "youtube",
        order: index,
      });
    });

    const { durations } = await fetchYouTubeDurations(
      validVideos.map((v) => v.youtubeVideoId).filter(Boolean) as string[],
      { referer: options.referer },
    );
    validVideos.forEach((v) => {
      if (v.youtubeVideoId && durations[v.youtubeVideoId] !== undefined) v.durationSeconds = durations[v.youtubeVideoId];
    });

    return {
      provider: "youtube",
      title: playlistItem.snippet?.title || "Imported playlist",
      description: playlistItem.snippet?.description || "",
      thumbnailUrl: playlistItem.snippet?.thumbnails?.high?.url || playlistItem.snippet?.thumbnails?.medium?.url || null,
      sourceUrl: url,
      totalVideos: validVideos.length,
      unavailableCount,
      videos: validVideos,
    };
  }

  /** Public-page fallback used when the Data API cannot serve the request. */
  private async fetchViaPublicPage(
    url: string,
    playlistId: string,
    dataApiReason: string,
  ): Promise<ExternalPlaylistPreview> {
    try {
      const page = await fetchYouTubePlaylistPage(playlistId);
      return {
        provider: "youtube",
        title: page.title,
        description: page.description,
        thumbnailUrl: page.thumbnailUrl || null,
        sourceUrl: url,
        totalVideos: page.totalVideos,
        unavailableCount: Math.max(0, page.totalVideos - page.videos.length),
        videos: page.videos,
      };
    } catch (error) {
      const pageMessage = error instanceof Error ? error.message : "Could not read the public playlist page.";
      throw new Error(
        `${dataApiReason} Public playlist fallback also failed: ${pageMessage}`,
      );
    }
  }
}

class DataApiFallbackError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "DataApiFallbackError";
    this.status = status;
  }
}

function isDataApiFallbackError(error: unknown): boolean {
  if (!(error instanceof DataApiFallbackError)) return false;
  // 400/401/403/429 are the "this key cannot serve requests" family: missing
  // key, key restricted to another API, API not enabled, quota exhausted.
  return [400, 401, 403, 429].includes(error.status);
}

/** HTTP status for a playlist-import failure, so the two import routes can
 *  surface the real reason instead of collapsing everything into a 500. */
export function externalPlaylistErrorStatus(error: unknown): number {
  if (error instanceof DataApiFallbackError && error.status === 404) return 404;
  const message = error instanceof Error ? error.message : "";
  if (/not configured on the server/i.test(message)) return 503;
  if (/valid|private|not found|unavailable|unsupported/i.test(message)) return 400;
  return 502;
}

export class FacebookCollectionProvider implements ExternalPlaylistProvider {
  provider: "facebook" = "facebook";

  detect(url: string): boolean {
    const parsed = parseVideoUrl(url);
    if (!parsed) return false;
    const host = parsed.hostname.toLowerCase();
    if (host !== "facebook.com" && host !== "www.facebook.com" && host !== "m.facebook.com") return false;
    return Boolean(extractFacebookCollectionId(parsed.toString()));
  }

  extractPlaylistId(url: string): string | null {
    return extractFacebookCollectionId(url);
  }

  // Listing a Page's video collection has no public equivalent (unlike a
  // single video's public embed) — it always goes through the Graph API
  // with a Page access token. See facebookGraph.ts's module doc, case 4.
  async fetchPreview(url: string): Promise<ExternalPlaylistPreview> {
    const collection = await fetchFacebookCollection(url);

    return {
      provider: "facebook",
      title: collection.title,
      description: collection.description,
      thumbnailUrl: collection.thumbnailUrl,
      sourceUrl: url,
      totalVideos: collection.videos.length,
      unavailableCount: 0,
      videos: collection.videos.map((video, index) => ({
        title: video.title,
        videoUrl: video.videoUrl,
        youtubeVideoId: null,
        thumbnailUrl: video.thumbnailUrl,
        durationSeconds: video.durationSeconds ?? undefined,
        description: video.description,
        creator: null,
        publishedAt: video.publishedAt,
        platform: "facebook",
        order: index,
      })),
    };
  }
}

export const externalPlaylistProviders: ExternalPlaylistProvider[] = [
  new YouTubePlaylistProvider(),
  new FacebookCollectionProvider(),
];

export function detectExternalPlaylistProvider(url: string): ExternalPlaylistProvider | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  return externalPlaylistProviders.find((provider) => provider.detect(trimmed)) ?? null;
}

export async function fetchExternalPlaylistPreview(
  url: string,
  options: ExternalPlaylistFetchOptions = {},
): Promise<ExternalPlaylistPreview> {
  const provider = detectExternalPlaylistProvider(url);
  if (!provider) {
    throw new Error("Unsupported playlist URL. Please paste a YouTube playlist or Facebook collection link.");
  }
  return provider.fetchPreview(url, options);
}
