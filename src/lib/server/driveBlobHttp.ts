/**
 * Fetch helpers for the Drive blob store: retry with exponential backoff + jitter (honours Retry-After) and
 * error classification. Response bodies are read only to find Google's error "reason"; they are never logged,
 * returned or put into an Error message.
 */
import { BlobStoreError } from "@/lib/server/driveBlobStore";

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export async function errorReason(response: Response): Promise<string> {
  try {
    const data = (await response.clone().json()) as { error?: { errors?: Array<{ reason?: unknown }>; status?: unknown } };
    const reason = data?.error?.errors?.[0]?.reason;
    return typeof reason === "string" ? reason : "";
  } catch {
    return "";
  }
}

export function retryDelayMs(response: Response, attempt: number, options: RetryOptions): number {
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 30) * 1000;
  const base = (options.baseDelayMs ?? 500) * 2 ** attempt;
  return base + Math.floor((options.random ?? Math.random)() * 250);
}

export async function fetchWithRetry(
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? 3;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    const response = await fetchFn(url, init);
    let retryable = RETRYABLE_STATUS.has(response.status);
    if (!retryable && response.status === 403) {
      const reason = await errorReason(response);
      retryable = reason === "rateLimitExceeded" || reason === "userRateLimitExceeded";
    }
    if (!retryable || attempt >= maxRetries) return response;
    await sleep(retryDelayMs(response, attempt, options));
  }
}

/** Throws a classified BlobStoreError for a non-OK response. 404 is returned as "not_found". */
export async function throwForStatus(response: Response): Promise<never> {
  const status = response.status;
  if (status === 401) throw new BlobStoreError("auth", 401);
  if (status === 404 || status === 410) throw new BlobStoreError("not_found");
  if (status === 403) {
    const reason = await errorReason(response);
    if (reason === "storageQuotaExceeded") throw new BlobStoreError("quota");
    if (reason === "rateLimitExceeded" || reason === "userRateLimitExceeded") throw new BlobStoreError("upstream");
    throw new BlobStoreError("scope_missing");
  }
  throw new BlobStoreError("upstream");
}
