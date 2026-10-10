// Shared helpers for the signed OAuth `state`. Pure (no Firebase, no I/O) so it is unit-testable.
// One secret: GOOGLE_OAUTH_STATE_SECRET, with a fallback to the old GOOGLE_WORKSPACE_OAUTH_STATE_SECRET name.
// (GOOGLE_DRIVE_OAUTH_STATE_SECRET was removed in G7.) The HMAC input is prefixed ("workspace.v1|") for domain separation.

import crypto from "crypto";

export const STATE_PREFIX = "workspace.v1|";

type EnvLike = Record<string, string | undefined>;

/** GOOGLE_OAUTH_STATE_SECRET first, then GOOGLE_WORKSPACE_OAUTH_STATE_SECRET. Null when neither is set. Whitespace is trimmed. */
export function getStateSecret(env: EnvLike = process.env): string | null {
  return env.GOOGLE_OAUTH_STATE_SECRET?.trim() || env.GOOGLE_WORKSPACE_OAUTH_STATE_SECRET?.trim() || null;
}

/** Same as getStateSecret but throws a message naming the variable (never the value). */
export function requireStateSecret(env: EnvLike = process.env): string {
  const secret = getStateSecret(env);
  if (!secret) throw new Error("GOOGLE_OAUTH_STATE_SECRET is not configured.");
  return secret;
}

/** HMAC-SHA256 hex over `${prefix}${payload}`. */
export function signWithPrefix(secret: string, prefix: string, payload: string): string {
  return crypto.createHmac("sha256", secret).update(`${prefix}${payload}`).digest("hex");
}

/** Constant-time comparison of two hex signatures. */
export function signaturesMatch(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}
