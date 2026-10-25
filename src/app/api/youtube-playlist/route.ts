import { NextResponse } from "next/server";
import { externalPlaylistErrorStatus, fetchExternalPlaylistPreview } from "@/lib/video-platforms/playlist";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { logServerError } from "@/lib/server/logError";

// Runs server-side only so the YouTube Data API key is never exposed to the
// browser. Any signed-in user may call this — both the admin shared-library
// importer and the personal "My Playlists" importer use it — but it stays
// behind authentication (rather than fully public) so anonymous traffic
// can't burn through the server's YouTube Data API quota.
export const GET = withAuthedRoute(async ({ req }) => {
  const playlistId = req.nextUrl.searchParams.get("playlistId");
  const rawUrl = req.nextUrl.searchParams.get("url");

  const sourceUrl = rawUrl || (playlistId ? `https://www.youtube.com/playlist?list=${encodeURIComponent(playlistId)}` : "");

  if (!sourceUrl.trim()) {
    return NextResponse.json({ error: "Missing playlist URL or playlistId" }, { status: 400 });
  }

  try {
    const preview = await fetchExternalPlaylistPreview(sourceUrl, { referer: req.nextUrl.origin });
    return NextResponse.json({
      title: preview.title,
      description: preview.description || "",
      thumbnailUrl: preview.thumbnailUrl || "",
      sourceUrl: preview.sourceUrl,
      totalVideos: preview.totalVideos,
      unavailableCount: preview.unavailableCount,
      videos: preview.videos.map((video) => ({
        title: video.title,
        youtubeVideoId: video.youtubeVideoId || null,
        videoUrl: video.videoUrl,
        thumbnailUrl: video.thumbnailUrl || "",
        durationSeconds: typeof video.durationSeconds === "number" ? video.durationSeconds : null,
        order: video.order,
      })),
    });
  } catch (err) {
    logServerError("YouTube playlist fetch failed", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch playlist" },
      { status: externalPlaylistErrorStatus(err) },
    );
  }
}, { scope: "youtube-playlist" });
