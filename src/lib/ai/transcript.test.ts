import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  YoutubeTranscriptDisabledError,
  YoutubeTranscriptNotAvailableError,
  YoutubeTranscriptTooManyRequestError,
  YoutubeTranscriptVideoUnavailableError,
} from "youtube-transcript";

import {
  classifyWatchPageHtml,
  classifyYouTubeFailure,
  cleanTranscript,
  getYouTubeTranscript,
  isAmbiguousYouTubeFailure,
  TranscriptUnavailableError,
} from "./transcript";

describe("classifyYouTubeFailure", () => {
  it("maps the library's captcha/IP-limit error to blocked", () => {
    assert.equal(classifyYouTubeFailure(new YoutubeTranscriptTooManyRequestError()), "blocked");
  });

  it("maps a genuinely missing video to unavailable", () => {
    assert.equal(classifyYouTubeFailure(new YoutubeTranscriptVideoUnavailableError("abcdefghijk")), "unavailable");
    assert.equal(classifyYouTubeFailure(new Error("Video unavailable")), "unavailable");
  });

  it("leaves disabled/not-available errors ambiguous for the HTML check", () => {
    assert.equal(classifyYouTubeFailure(new YoutubeTranscriptDisabledError("abcdefghijk")), "unknown");
    assert.equal(classifyYouTubeFailure(new YoutubeTranscriptNotAvailableError("abcdefghijk")), "unknown");
    assert.equal(classifyYouTubeFailure(new Error("something unexpected")), "unknown");
  });

  it("recognises only the errors whose meaning depends on the watch page", () => {
    assert.equal(isAmbiguousYouTubeFailure(new YoutubeTranscriptDisabledError("abcdefghijk")), true);
    assert.equal(isAmbiguousYouTubeFailure(new YoutubeTranscriptNotAvailableError("abcdefghijk")), true);
    assert.equal(isAmbiguousYouTubeFailure(new YoutubeTranscriptTooManyRequestError()), false);
    assert.equal(isAmbiguousYouTubeFailure(new YoutubeTranscriptVideoUnavailableError("abcdefghijk")), false);
    assert.equal(isAmbiguousYouTubeFailure("unknown"), false);
  });
});

describe("classifyWatchPageHtml", () => {
  it("detects YouTube's bot/login page before anything else", () => {
    const html = '<html>"playabilityStatus":{"status":"LOGIN_REQUIRED"} "captions":{}</html>';
    assert.equal(classifyWatchPageHtml(html), "blocked");
    assert.equal(classifyWatchPageHtml('<div class="g-recaptcha"></div>'), "blocked");
  });

  it("detects caption tracks on a playable page", () => {
    const html = '<html>"playabilityStatus":{"status":"OK"} "captions":{"playerCaptionsTracklistRenderer":{}}</html>';
    assert.equal(classifyWatchPageHtml(html), "has_captions");
  });

  it("reports no captions when the page is playable but has no caption tracks", () => {
    assert.equal(classifyWatchPageHtml('<html>"playabilityStatus":{"status":"OK"}</html>'), "no_captions");
  });

  it("returns unknown for HTML that proves nothing", () => {
    assert.equal(classifyWatchPageHtml("<html>consent</html>"), "unknown");
  });
});

describe("cleanTranscript", () => {
  it("drops music/applause markers and collapses whitespace", () => {
    assert.equal(cleanTranscript("  hello   [Music] world\n[applause] "), "hello world");
  });
});

describe("getYouTubeTranscript", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("classifies an ambiguous disabled error by asking the watch page exactly once", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/youtubei/v1/player")) return jsonResponse({});
      if (urls.length === 2) return htmlResponse('<html>"playabilityStatus":{"status":"OK"}</html>');
      return htmlResponse("<html>LOGIN_REQUIRED</html>");
    }) as typeof fetch;

    await assert.rejects(
      () => getYouTubeTranscript("abcdefghijk"),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptUnavailableError);
        assert.equal(error.reason, "blocked");
        return true;
      },
    );
    assert.equal(urls.length, 3);
    assert.match(urls[2], /watch\?v=abcdefghijk/);
  });

  it("tells a real caption-less video apart from a blocked server", async () => {
    let calls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls += 1;
      const url = String(input);
      if (url.includes("/youtubei/v1/player")) return jsonResponse({});
      if (calls === 2) return htmlResponse('<html>"playabilityStatus":{"status":"OK"}</html>');
      return htmlResponse('<html>"playabilityStatus":{"status":"OK"}</html>');
    }) as typeof fetch;

    await assert.rejects(
      () => getYouTubeTranscript("abcdefghijk"),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptUnavailableError);
        assert.equal(error.reason, "no_captions");
        return true;
      },
    );
    assert.equal(calls, 3);
  });

  it("does not ask for the watch page when the library already proved an IP block", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/youtubei/v1/player")) return jsonResponse({});
      return htmlResponse('<html><div class="g-recaptcha"></div>"playabilityStatus":</html>');
    }) as typeof fetch;

    await assert.rejects(
      () => getYouTubeTranscript("abcdefghijk"),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptUnavailableError);
        assert.equal(error.reason, "blocked");
        return true;
      },
    );
    assert.equal(urls.length, 2);
  });

  it("reports a removed video without a second request", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("/youtubei/v1/player")) return jsonResponse({});
      return htmlResponse("<html>not a player page</html>");
    }) as typeof fetch;

    await assert.rejects(
      () => getYouTubeTranscript("abcdefghijk"),
      (error: unknown) => {
        assert.ok(error instanceof TranscriptUnavailableError);
        assert.equal(error.reason, "unavailable");
        return true;
      },
    );
    assert.equal(urls.length, 2);
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 });
}

function htmlResponse(html: string): Response {
  return new Response(html, { status: 200 });
}
