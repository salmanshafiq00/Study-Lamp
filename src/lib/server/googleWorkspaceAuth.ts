import { getGoogleClient } from "@/lib/server/googleClientConfig";
import {
  buildGoogleAuthUrl,
  exchangeCode,
  fetchGoogleAccountEmail,
  refreshToken,
  revoke,
  type GoogleOAuthClient,
} from "@/lib/server/googleOAuth";
import { getStateSecret, requireStateSecret, signWithPrefix, signaturesMatch, STATE_PREFIX as STATE_PREFIX_VALUE } from "@/lib/server/googleOAuthState";
import { googleFeaturesFromGrantedScopes, isGoogleFeature, scopesForGoogleFeatures, type GoogleFeature } from "@/lib/googleScopes";

// Step W2: Workspace-specific OAuth glue. The generic network primitives live
// in src/lib/server/googleOAuth.ts; this module owns the Workspace OAuth
// client config, the signed `state` format and the callback's persistence.

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_PREFIX = STATE_PREFIX_VALUE; // "workspace.v1|": domain separation for the signed state.
export const WORKSPACE_REDIRECT_PATH = "/api/google/auth/callback";
export const WORKSPACE_NONCE_COOKIE = "sl_google_nonce";

/** The Workspace OAuth client, read from env. Throws a clear message when a
 *  variable is missing rather than silently sending an empty client_id. */
function workspaceClient(): GoogleOAuthClient {
  const credentials = getGoogleClient();
  if (!credentials) {
    throw new Error("Google Workspace isn't configured (missing GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET).");
  }
  return { ...credentials, redirectPath: WORKSPACE_REDIRECT_PATH };
}

function stateSecret(): string {
  return requireStateSecret();
}

/** Configured for every Google feature (Drive, Calendar, Tasks): client pair + state secret. */
export function isWorkspaceConfigured(): boolean {
  return Boolean(getGoogleClient() && getStateSecret());
}

/** The auth URL for the requested features, with incremental consent so a
 *  later "Allow Tasks access" keeps the Calendar grant the user already made. */
export function buildWorkspaceAuthUrl(
  origin: string,
  state: string,
  features: readonly GoogleFeature[],
): string {
  return buildGoogleAuthUrl(origin, state, workspaceClient(), {
    scope: scopesForGoogleFeatures(features).join(" "),
    includeGrantedScopes: true,
    accessType: "offline",
    prompt: "consent",
  });
}

/** Signs {uid, nonce, features, ts} with HMAC-SHA256. The HMAC input is
 *  prefixed with "workspace.v1|" so a Workspace state can never be replayed
 *  as a Drive state (and vice versa) even if the secrets were ever shared. */
export function signWorkspaceState(
  uid: string,
  nonce: string,
  features: readonly GoogleFeature[] = [],
  nowMs = Date.now(),
): string {
  const payload = JSON.stringify({ uid, nonce, features: [...features], ts: nowMs });
  const signature = signWithPrefix(stateSecret(), STATE_PREFIX, payload);
  return Buffer.from(`${payload}.${signature}`).toString("base64url");
}

/** Verifies a state produced by signWorkspaceState. Returns null (never
 *  throws) for anything malformed, expired (>10 min), tampered, bound to a
 *  different nonce, or carrying features the caller did not request. */
export function verifyWorkspaceState(
  state: string,
  expectedNonce: string | null,
  expectedFeatures: readonly GoogleFeature[] = [],
  nowMs = Date.now(),
): { uid: string; nonce: string; features: GoogleFeature[] } | null {
  if (!expectedNonce) return null;
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const lastDot = decoded.lastIndexOf(".");
    if (lastDot <= 0) return null;
    const payloadPart = decoded.slice(0, lastDot);
    const sigPart = decoded.slice(lastDot + 1);
    const payload = JSON.parse(payloadPart) as { uid?: string; nonce?: string; features?: string[]; ts?: number };
    if (!payload.uid || !payload.nonce || !Number.isFinite(payload.ts)) return null;

    if (!signaturesMatch(sigPart, signWithPrefix(stateSecret(), STATE_PREFIX, payloadPart))) return null;

    const age = nowMs - Number(payload.ts);
    if (age < 0 || age > STATE_TTL_MS) return null;
    if (payload.nonce !== expectedNonce) return null;

    const features = Array.isArray(payload.features)
      ? payload.features.filter((value): value is GoogleFeature => isGoogleFeature(value))
      : [];
    if (expectedFeatures.length && !expectedFeatures.every((feature) => features.includes(feature))) return null;

    return { uid: payload.uid, nonce: payload.nonce, features };
  } catch {
    return null;
  }
}

export interface WorkspaceTokenExchangeResult {
  refreshToken: string;
  accessToken: string;
  grantedFeatures: GoogleFeature[];
}

/** Exchanges the code and reads the GRANTED scope string from the token
 *  response (not the requested list) so a partial grant is recorded honestly. */
export async function exchangeWorkspaceCode(code: string, origin: string): Promise<WorkspaceTokenExchangeResult> {
  const tokens = await exchangeCode(code, origin, workspaceClient());
  return {
    refreshToken: tokens.refresh_token ?? "",
    accessToken: tokens.access_token,
    grantedFeatures: googleFeaturesFromGrantedScopes(tokens.scope),
  };
}

export async function getWorkspaceAccountEmail(accessToken: string): Promise<string> {
  return fetchGoogleAccountEmail(accessToken);
}

export async function refreshWorkspaceAccessToken(refreshTokenValue: string): Promise<{ accessToken: string; expiresIn: number }> {
  return refreshToken(refreshTokenValue, workspaceClient());
}

export async function revokeWorkspaceToken(token: string): Promise<void> {
  return revoke(token);
}
