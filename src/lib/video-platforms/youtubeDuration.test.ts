import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  extractLengthSecondsFromPlayerJson,
  parseDurationText,
} from "./youtubeDurationFallback";
import { fetchYouTubeDurations, parseIso8601Duration } from "./youtubeDuration";

describe("duration text parsing", () => {
  it("parses thumbnail/legacy display durations", () => {
    assert.equal(parseDurationText("6:34"), 394);
    assert.equal(parseDurationText("12:34"), 754);
    assert.equal(parseDurationText("1:02:03"), 3723);
    assert.equal(parseDurationText(" 0:45 "), 45);
  });

  it("rejects live badges and malformed values", () => {
    assert.equal(parseDurationText("LIVE"), null);
    assert.equal(parseDurationText("NEW"), null);
    assert.equal(parseDurationText(""), null);
    assert.equal(parseDurationText(null), null);
    assert.equal(parseDurationText("1:2:3:4"), null);
    assert.equal(parseDurationText("0:00"), null);
  });

  it("parses ISO 8601 durations from the Data API", () => {
    assert.equal(parseIso8601Duration("PT15M33S"), 933);
    assert.equal(parseIso8601Duration("PT1H2M3S"), 3723);
    assert.equal(parseIso8601Duration("PT0S"), 0);
    assert.equal(parseIso8601Duration("P1D"), null);
  });

  it("reads lengthSeconds from an InnerTube player response", () => {
    assert.equal(extractLengthSecondsFromPlayerJson({ videoDetails: { lengthSeconds: "678" } }), 678);
    assert.equal(extractLengthSecondsFromPlayerJson({ videoDetails: { lengthSeconds: 678 } }), 678);
    assert.equal(extractLengthSecondsFromPlayerJson({ playabilityStatus: { status: "ERROR" } }), null);
    assert.equal(extractLengthSecondsFromPlayerJson(null), null);
    assert.equal(extractLengthSecondsFromPlayerJson({ videoDetails: { lengthSeconds: "0" } }), null);
  });
});

interface FetchCall {
  url: string;
  referer: string | null;
  videoId: string | null;
}

function installFetchMock(handler: (call: FetchCall) => { status: number; body: unknown }) {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(init?.headers);
    let videoId: string | null = null;
    if (url.includes("/youtubei/v1/player")) {
      try {
        videoId = JSON.parse(String(init?.body ?? "{}")).videoId ?? null;
      } catch {
        videoId = null;
      }
    }
    const call = { url, referer: headers.get("referer"), videoId };
    calls.push(call);
    const { status, body } = handler(call);
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("fetchYouTubeDurations", () => {
  const originalKey = process.env.YOUTUBE_API_KEY;
  let restoreFetch: (() => void) | null = null;

  beforeEach(() => {
    process.env.YOUTUBE_API_KEY = "test-key";
  });

  afterEach(() => {
    restoreFetch?.();
    restoreFetch = null;
    if (originalKey === undefined) delete process.env.YOUTUBE_API_KEY;
    else process.env.YOUTUBE_API_KEY = originalKey;
  });

  it("sends the caller origin as Referer to the Data API", async () => {
    const videoId = "ref-test-1";
    const mock = installFetchMock(() => ({
      status: 200,
      body: { items: [{ id: videoId, contentDetails: { duration: "PT10M" } }] },
    }));
    restoreFetch = mock.restore;

    const { durations, error } = await fetchYouTubeDurations([videoId], { referer: "http://localhost:3000" });
    assert.equal(error, null);
    assert.equal(durations[videoId], 600);
    assert.equal(mock.calls.length, 1);
    assert.match(mock.calls[0].url, /googleapis\.com/);
    assert.equal(mock.calls[0].referer, "http://localhost:3000/");
  });

  it("fills only the IDs the Data API omitted, without re-requesting the resolved ones", async () => {
    const ids = ["merge-test-a", "merge-test-b", "merge-test-c"];
    const mock = installFetchMock((call) => {
      if (call.url.includes("googleapis.com")) {
        return { status: 200, body: { items: [{ id: ids[0], contentDetails: { duration: "PT1M" } }] } };
      }
      return { status: 200, body: { videoDetails: { lengthSeconds: "30" } } };
    });
    restoreFetch = mock.restore;

    const { durations, error } = await fetchYouTubeDurations(ids, { referer: "https://studylamp.vercel.app" });
    assert.equal(error, null);
    assert.deepEqual(durations, { [ids[0]]: 60, [ids[1]]: 30, [ids[2]]: 30 });

    const playerCalls = mock.calls.filter((call) => call.url.includes("/youtubei/v1/player"));
    assert.deepEqual(playerCalls.map((call) => call.videoId).sort(), [ids[1], ids[2]]);
  });

  it("recovers from a referrer-blocked key via the keyless fallback", async () => {
    const ids = ["blocked-test-a", "blocked-test-b"];
    const mock = installFetchMock((call) => {
      if (call.url.includes("googleapis.com")) {
        return { status: 403, body: { error: { message: "Requests from referer <empty> are blocked." } } };
      }
      return { status: 200, body: { videoDetails: { lengthSeconds: "42" } } };
    });
    restoreFetch = mock.restore;

    const { durations, error } = await fetchYouTubeDurations(ids);
    assert.deepEqual(durations, { [ids[0]]: 42, [ids[1]]: 42 });
    // Every ID resolved, so the Data API failure is not surfaced as an error.
    assert.equal(error, null);
  });

  it("works with no API key at all", async () => {
    delete process.env.YOUTUBE_API_KEY;
    const ids = ["nokey-test-a"];
    const mock = installFetchMock(() => ({ status: 200, body: { videoDetails: { lengthSeconds: 75 } } }));
    restoreFetch = mock.restore;

    const { durations, error } = await fetchYouTubeDurations(ids);
    assert.deepEqual(durations, { [ids[0]]: 75 });
    assert.equal(error, null);
    assert.ok(mock.calls.every((call) => !call.url.includes("googleapis.com")));
  });

  it("reports a reason when neither source can resolve a duration", async () => {
    const ids = ["unresolved-test"];
    const mock = installFetchMock((call) => {
      if (call.url.includes("googleapis.com")) {
        return { status: 403, body: { error: { message: "Requests from referer <empty> are blocked." } } };
      }
      return { status: 200, body: { playabilityStatus: { status: "ERROR" } } };
    });
    restoreFetch = mock.restore;

    const { durations, error } = await fetchYouTubeDurations(ids);
    assert.deepEqual(durations, {});
    assert.match(error || "", /referer <empty> are blocked/i);
  });
});
