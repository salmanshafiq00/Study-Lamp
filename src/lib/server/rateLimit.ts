/**
 * Named per-minute limits. Pick the preset that matches how often a normal
 * browser legitimately calls the route:
 *  - stream:    video seeking and PDF range loading fire many requests per minute
 *  - thumbnail: a grid of Drive thumbnails loads dozens of images at once
 *  - sign:      thumbnail/stream URL signing; the client already batches up to 50 items per request
 *  - import:    bulk Drive import (one request can carry up to 200 files)
 *  - authSensitive: OAuth state/callback and upload sessions, which should be rare
 */
export const RATE_LIMITS = {
  default: { limit: 60 },
  authSensitive: { limit: 10 },
  stream: { limit: 1200 },
  thumbnail: { limit: 600 },
  sign: { limit: 180 },
  import: { limit: 30 },
  googleSync: { limit: 30 },
  googleApply: { limit: 20 },
  blob: { limit: 60 },
} as const;

export type RateLimitPreset = keyof typeof RATE_LIMITS;

interface RateLimitOptions {
  scope?: string;
  /** Named limit. An explicit `limit` wins over the preset. */
  preset?: RateLimitPreset;
  limit?: number;
  windowMs?: number;
  now?: number;
}

const requestsByKey = new Map<string, number[]>();

/**
 * Per-process sliding-window limiter.
 *
 * Caveat: state lives in this server instance's memory, so with several
 * serverless instances the effective limit is roughly `limit x instances`, and
 * it resets on a cold start. It is a safety net against runaway clients, not a
 * hard quota; distributed deployments need a shared store (e.g. Redis).
 */
export function checkRateLimit(uid: string, options: RateLimitOptions = {}): boolean {
  const scope = options.scope || "default";
  const limit = options.limit ?? RATE_LIMITS[options.preset ?? "default"].limit;
  const windowMs = options.windowMs ?? 60_000;
  const now = options.now ?? Date.now();
  const key = `${scope}:${uid}`;
  const cutoff = now - windowMs;
  const timestamps = (requestsByKey.get(key) || []).filter((timestamp) => timestamp > cutoff);

  if (timestamps.length >= limit) {
    requestsByKey.set(key, timestamps);
    return false;
  }

  timestamps.push(now);
  requestsByKey.set(key, timestamps);

  if (requestsByKey.size > 10_000) {
    for (const [storedKey, storedTimestamps] of requestsByKey) {
      const active = storedTimestamps.filter((timestamp) => timestamp > cutoff);
      if (active.length) requestsByKey.set(storedKey, active);
      else requestsByKey.delete(storedKey);
    }
  }
  return true;
}
