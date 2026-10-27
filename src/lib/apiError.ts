/**
 * Error thrown by the thin client wrappers when an API route answers non-2xx.
 * Carries the route's stable `code` so the video pages can react to
 * transcript failures without matching on message text.
 */
export class ApiRequestError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.code = code;
  }
}

export function getApiErrorCode(error: unknown): string | undefined {
  return error instanceof ApiRequestError ? error.code : undefined;
}

export function getApiErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** Parses a JSON object response body; anything else becomes an empty object. */
export async function readApiResponseBody(res: Response): Promise<Record<string, unknown>> {
  const data: unknown = await res.json().catch(() => ({}));
  return data && typeof data === "object" && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

export function apiErrorFromResponse(res: Response, body: Record<string, unknown>): ApiRequestError {
  return new ApiRequestError(
    typeof body.error === "string" ? body.error : `Request failed (${res.status})`,
    typeof body.code === "string" ? body.code : undefined,
  );
}
