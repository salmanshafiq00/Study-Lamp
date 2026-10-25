import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  collectContinuationTokens,
  collectPlaylistPageVideos,
  extractJsonAfterMarker,
} from "./youtubePlaylistPage";

function lockup(videoId: string, title: string, duration?: string) {
  return {
    lockupViewModel: {
      contentId: videoId,
      contentType: "LOCKUP_CONTENT_TYPE_VIDEO",
      metadata: { lockupMetadataViewModel: { title: { content: title } } },
      contentImage: {
        thumbnailViewModel: {
          image: {
            sources: [
              { url: `https://i.ytimg.com/vi/${videoId}/default.jpg`, width: 120, height: 90 },
              { url: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, width: 480, height: 360 },
            ],
          },
          overlays: duration
            ? [{ thumbnailBottomOverlayViewModel: { badges: [{ thumbnailBadgeViewModel: { text: duration } }] } }]
            : [],
        },
      },
    },
  };
}

describe("YouTube public playlist fallback parsing", () => {
  it("extracts ytInitialData without being confused by braces/quotes in strings", () => {
    const payload = { metadata: { playlistMetadataRenderer: { title: 'A "quoted" {title}' } }, contents: [] };
    const html = `<html><script>var ytInitialData = ${JSON.stringify(payload)};</script><script>var other = {};</script></html>`;
    assert.deepEqual(extractJsonAfterMarker(html, "var ytInitialData ="), payload);
  });

  it("returns null when the marker or a balanced JSON value is missing", () => {
    assert.equal(extractJsonAfterMarker("<html></html>", "var ytInitialData ="), null);
    assert.equal(extractJsonAfterMarker("var ytInitialData = {broken", "var ytInitialData ="), null);
  });

  it("collects modern lockupViewModel videos and deduplicates them", () => {
    const payload = {
      contents: [lockup("abc123", "First video", "6:34"), lockup("def456", "Second video", "1:02:03"), lockup("abc123", "First video duplicate")],
    };
    const videos = collectPlaylistPageVideos(payload);
    assert.equal(videos.length, 2);
    assert.deepEqual(videos.map((video) => video.youtubeVideoId), ["abc123", "def456"]);
    assert.equal(videos[0].videoUrl, "https://www.youtube.com/watch?v=abc123");
    assert.equal(videos[0].thumbnailUrl, "https://i.ytimg.com/vi/abc123/hqdefault.jpg");
    assert.equal(videos[1].order, 1);
    assert.equal(videos[0].durationSeconds, 394);
    assert.equal(videos[1].durationSeconds, 3723);
  });

  it("also reads the older playlistVideoRenderer shape and skips private/deleted entries", () => {
    const payload = {
      playlistVideoRenderer: {
        videoId: "ghi789",
        title: { runs: [{ text: "Legacy " }, { text: "video" }] },
        thumbnail: { thumbnails: [{ url: "https://i.ytimg.com/vi/ghi789/mqdefault.jpg" }] },
        lengthText: { simpleText: "12:34" },
      },
    };
    const videos = collectPlaylistPageVideos(payload, 10);
    assert.equal(videos.length, 1);
    assert.equal(videos[0].title, "Legacy video");
    assert.equal(videos[0].order, 10);
    assert.equal(videos[0].durationSeconds, 754);

    const hidden = collectPlaylistPageVideos({ contents: [lockup("x", "Private video"), lockup("y", "Deleted video")] });
    assert.equal(hidden.length, 0);
  });

  it("finds continuation tokens in both the initial and continued shapes", () => {
    const payload = {
      contents: [
        {
          continuationItemViewModel: {
            continuationCommand: {
              innertubeCommand: { continuationCommand: { token: "token-a" } },
            },
          },
        },
        { continuationEndpoint: { continuationCommand: { token: "token-b" } } },
        { continuationCommand: { token: "token-a" } },
      ],
    };
    assert.deepEqual(collectContinuationTokens(payload), ["token-a", "token-b"]);
  });
});
