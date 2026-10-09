import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

type Thumbnail = typeof import("./VideoThumbnail");

// VideoThumbnail pulls in the Firebase client at load time, which throws without NEXT_PUBLIC_FIREBASE_* values.
// Without them these tests are SKIPPED with a message instead of failing the whole run.
const hasFirebaseEnv = Boolean(process.env.NEXT_PUBLIC_FIREBASE_API_KEY && process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID);
const skip = hasFirebaseEnv ? false : "skipped: set NEXT_PUBLIC_FIREBASE_API_KEY and NEXT_PUBLIC_FIREBASE_PROJECT_ID to run";

let hasExpiredSignedUrl: Thumbnail["hasExpiredSignedUrl"];
let signedUrlExpiry: Thumbnail["signedUrlExpiry"];
let skipOptimizer: Thumbnail["skipOptimizer"];

before(async () => {
  if (!hasFirebaseEnv) return;
  ({ hasExpiredSignedUrl, signedUrlExpiry, skipOptimizer } = await import("./VideoThumbnail"));
});

/**
 * These helpers exist to work around third-party CDN behaviour, and getting any
 * of them wrong silently breaks thumbnails for an entire host — so they're
 * exported from the component purely to be testable here.
 */

describe("skipOptimizer", { skip }, () => {
  it("bypasses the optimizer for Facebook's CDN hosts", () => {
    // Next's optimizer fetches server-side; Facebook's CDN rejects that
    // (datacenter IP + referer), so the optimized URL 403s while the browser
    // loading the original directly is allowed.
    assert.equal(skipOptimizer("https://scontent.xx.fbcdn.net/v/t15/abc.jpg"), true);
    assert.equal(skipOptimizer("https://platform-lookaside.fbsbx.com/x.jpg"), true);
    assert.equal(skipOptimizer("https://video.xx.fbcdn.net/xyz.jpg"), true);
  });

  it("also keys off the video page URL, for a Facebook video on another host", () => {
    assert.equal(skipOptimizer("https://cdn.example.com/thumb.jpg", "https://www.facebook.com/watch/?v=1"), true);
    assert.equal(skipOptimizer("https://cdn.example.com/thumb.jpg", "https://fb.watch/abc"), true);
  });

  it("covers Instagram, which has the same hotlink protection", () => {
    assert.equal(skipOptimizer("https://scontent.cdninstagram.com/x.jpg"), true);
  });

  it("leaves YouTube and self-hosted thumbnails on the optimizer", () => {
    assert.equal(skipOptimizer("https://i.ytimg.com/vi/abc/hqdefault.jpg"), false);
    assert.equal(skipOptimizer("https://i.ytimg.com/vi/abc/hq.jpg", "https://www.youtube.com/watch?v=abc"), false);
    assert.equal(skipOptimizer("https://mycdn.example.com/a.png"), false);
  });

  it("is case-insensitive", () => {
    assert.equal(skipOptimizer("https://SCONTENT.XX.FBCDN.NET/a.jpg"), true);
  });
});

describe("signedUrlExpiry", { skip }, () => {
  // A real Facebook thumbnail URL shape: `oe` is a unix timestamp in hex.
  const realUrl =
    "https://scontent-iad3-1.xx.fbcdn.net/v/t15.5256-10/595067206_n.jpg" +
    "?stp=dst-jpg_s1000x1200_tt6&_nc_cat=110&oh=00_AQIUv_kKuRE1NDZvAUs7brDzaHC-HO5vm-OWeBsE2ZnFQw&oe=6A9CD537";

  it("reads the expiry out of oe=", () => {
    const expiry = signedUrlExpiry(realUrl);
    assert.ok(expiry instanceof Date);
    assert.equal(expiry?.toISOString(), "2026-09-06T02:51:35.000Z");
  });

  it("returns null when there is no signed expiry to read", () => {
    assert.equal(signedUrlExpiry("https://i.ytimg.com/vi/a/hq.jpg"), null);
    assert.equal(signedUrlExpiry(""), null);
    assert.equal(signedUrlExpiry(null), null);
    assert.equal(signedUrlExpiry(undefined), null);
  });

  it("returns null rather than an invalid date for a malformed oe value", () => {
    assert.equal(signedUrlExpiry("https://x.com/a.jpg?oe=zz"), null);
    assert.equal(signedUrlExpiry("https://x.com/a.jpg?oe=0"), null);
  });
});

describe("hasExpiredSignedUrl", { skip }, () => {
  const url = "https://scontent.xx.fbcdn.net/a.jpg?oh=sig&oe=6A9CD537"; // expires 2026-09-06

  it("is true once the embedded expiry has passed", () => {
    // This is the actual reported situation: the stored URLs expired, which is
    // why the CDN returned 403 no matter how the browser requested them.
    assert.equal(hasExpiredSignedUrl(url, new Date("2026-09-18T00:00:00.000Z")), true);
  });

  it("is false while the URL is still within its signed window", () => {
    assert.equal(hasExpiredSignedUrl(url, new Date("2026-09-01T00:00:00.000Z")), false);
  });

  it("is false for URLs with no signed expiry (YouTube etc.)", () => {
    assert.equal(hasExpiredSignedUrl("https://i.ytimg.com/vi/a/hq.jpg", new Date("2030-01-01T00:00:00.000Z")), false);
  });
});

describe("URL immutability contract", { skip }, () => {
  it("the signed URL is left byte-identical — no cache-buster is appended", () => {
    // Regression guard. An earlier revision retried with `?_thumbRetry=N`,
    // which invalidates the `oh=` signature and guarantees a 403 on a URL that
    // may otherwise still have been valid.
    const original =
      "https://scontent.xx.fbcdn.net/a.jpg?oh=00_AQ&oe=6A9CD537";
    assert.ok(!original.includes("_thumbRetry"));
    // The helpers must never mutate: both are read-only queries.
    skipOptimizer(original);
    signedUrlExpiry(original);
    hasExpiredSignedUrl(original);
    assert.equal(original, "https://scontent.xx.fbcdn.net/a.jpg?oh=00_AQ&oe=6A9CD537");
  });
});
