import { NextResponse } from "next/server";
import { fetchYouTubeDurations } from "@/lib/video-platforms/youtubeDuration";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { logServerError } from "@/lib/server/logError";

// Runs server-side only so the YouTube Data API key is never exposed to the
// browser. Used two ways: (1) backfilling duration right after a single
// "paste a URL" add, since oEmbed doesn't return duration; (2) the
// "Fix missing durations" bulk backfill for videos saved before this
// endpoint existed. Accepts up to 50 ids per request (the Data API's limit).
export const GET = withAuthedRoute(async ({ req }) => {
  const idsParam = req.nextUrl.searchParams.get("ids") || "";
  const ids = idsParam.split(",").map((id) => id.trim()).filter(Boolean).slice(0, 50);
  if (ids.length === 0) {
    return NextResponse.json({ error: "Missing ids" }, { status: 400 });
  }

  try {
    // Pass the caller's origin as Referer: API keys restricted by HTTP
    // referrer reject server-to-server requests that have no Referer header.
    const { durations, error } = await fetchYouTubeDurations(ids, { referer: req.nextUrl.origin });
    return NextResponse.json({ durations, error });
  } catch (err) {
    logServerError("YouTube duration lookup failed", err);
    return NextResponse.json({ error: "Failed to fetch durations" }, { status: 500 });
  }
}, { scope: "youtube-duration" });
