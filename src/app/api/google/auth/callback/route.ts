import { NextRequest, NextResponse } from "next/server";
import {
  verifyWorkspaceState,
  isWorkspaceConfigured,
  WORKSPACE_NONCE_COOKIE,
  exchangeWorkspaceCode,
  getWorkspaceAccountEmail,
} from "@/lib/server/googleWorkspaceAuth";
import { upsertGoogleConnection } from "@/lib/server/googleConnections";
import { checkRateLimit } from "@/lib/server/rateLimit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectAndClearNonce(settingsUrl: URL): NextResponse {
  const response = NextResponse.redirect(settingsUrl);
  response.cookies.set(WORKSPACE_NONCE_COOKIE, "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/google/auth",
    maxAge: 0,
  });
  return response;
}

// Step 2 of the Workspace OAuth flow: Google redirects the user's browser here
// (no Authorization header — a plain top-level navigation). The signed `state`
// plus the sl_google_nonce cookie tie it back to a Study Lamp user.
export async function GET(request: NextRequest) {
  // Settings → Google is the single page for Drive, Calendar and Tasks.
  const settingsUrl = new URL("/settings/google", request.url);

  if (!isWorkspaceConfigured()) {
    settingsUrl.searchParams.set("error", "Google Workspace isn't configured on this deployment yet.");
    return redirectAndClearNonce(settingsUrl);
  }

  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const errorParam = url.searchParams.get("error");
  const nonceCookie = request.cookies.get(WORKSPACE_NONCE_COOKIE)?.value ?? null;

  if (errorParam) {
    settingsUrl.searchParams.set(
      "error",
      errorParam === "access_denied" ? "You did not grant Google access, so nothing changed." : "Google reported an error while connecting. Please try again.",
    );
    return redirectAndClearNonce(settingsUrl);
  }

  if (!code || !state || !nonceCookie) {
    settingsUrl.searchParams.set("error", "This connection link expired or is invalid. Try connecting again.");
    return redirectAndClearNonce(settingsUrl);
  }

  const verification = verifyWorkspaceState(state, nonceCookie);
  if (!verification) {
    settingsUrl.searchParams.set("error", "This connection link expired or is invalid. Try connecting again.");
    return redirectAndClearNonce(settingsUrl);
  }
  // Return to the card the user started from (the Google page scrolls to ?tab=calendar|tasks).
  settingsUrl.searchParams.set("tab", verification.features[0] ?? "calendar");

  if (!checkRateLimit(verification.uid, { scope: "google:auth-callback", preset: "authSensitive" })) {
    settingsUrl.searchParams.set("error", "Too many connection attempts. Try again shortly.");
    return redirectAndClearNonce(settingsUrl);
  }

  try {
    const tokens = await exchangeWorkspaceCode(code, request.nextUrl.origin);
    if (!tokens.refreshToken) {
      settingsUrl.searchParams.set("error", "Google didn't grant offline access. Try disconnecting any prior Study Lamp access in your Google Account settings, then reconnect.");
      return redirectAndClearNonce(settingsUrl);
    }

    const googleEmail = await getWorkspaceAccountEmail(tokens.accessToken);
    // Record the features Google actually granted (the token response's scope
    // string), MERGING with whatever was already granted so an incremental
    // "Allow Tasks access" never drops the earlier Calendar grant.
    await upsertGoogleConnection(verification.uid, {
      googleEmail,
      refreshToken: tokens.refreshToken,
      grantedScopes: tokens.grantedFeatures,
    });

    settingsUrl.searchParams.set("connected", googleEmail);
    // If the user unticked something on Google's consent screen, tell the
    // settings page which feature is still missing so it can offer a retry.
    const missing = verification.features.filter((feature) => !tokens.grantedFeatures.includes(feature));
    if (missing.length > 0) settingsUrl.searchParams.set("missing", missing.join(","));
    return redirectAndClearNonce(settingsUrl);
  } catch {
    settingsUrl.searchParams.set("error", "Something went wrong connecting Google. Please try again.");
    return redirectAndClearNonce(settingsUrl);
  }
}
