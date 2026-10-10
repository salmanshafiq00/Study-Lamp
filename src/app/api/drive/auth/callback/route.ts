import { NextRequest, NextResponse } from "next/server";
import { verifyDriveState, exchangeCodeForTokens, getGoogleAccountEmail } from "@/lib/server/googleDrive";
import { logServerError } from "@/lib/server/logError";
import { upsertDriveConnection } from "@/lib/server/driveConnections";
import { checkRateLimit } from "@/lib/server/rateLimit";

function redirectAndClearNonce(settingsUrl: URL): NextResponse {
  const response = NextResponse.redirect(settingsUrl);
  response.cookies.set("sl_drive_nonce", "", {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/drive/auth",
    maxAge: 0,
  });
  return response;
}

// Step 2 of the OAuth flow: Google redirects the user's browser here with
// ?code&state (no Authorization header — this is a plain top-level
// navigation, not a fetch from our own client code). The signed `state`
// param is what ties this back to a Study Lamp user (see signDriveState).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const origin = req.nextUrl.origin;
  // Drive settings live on the single Google page; ?tab=drive makes it scroll to the Drive card.
  const settingsUrl = new URL("/settings/google", origin);
  settingsUrl.searchParams.set("tab", "drive");

  const error = req.nextUrl.searchParams.get("error");
  if (error) {
    settingsUrl.searchParams.set("error", error === "access_denied" ? "You didn't grant access, so nothing was connected." : error);
    return redirectAndClearNonce(settingsUrl);
  }

  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  if (!code || !state) {
    settingsUrl.searchParams.set("error", "Missing code or state from Google.");
    return redirectAndClearNonce(settingsUrl);
  }

  const nonceCookie = req.cookies.get("sl_drive_nonce")?.value ?? null;
  const verified = verifyDriveState(state, nonceCookie);
  if (!verified) {
    settingsUrl.searchParams.set("error", "That connection link expired or is invalid. Try connecting again.");
    return redirectAndClearNonce(settingsUrl);
  }
  if (!checkRateLimit(verified.uid, { scope: "drive:auth-callback", limit: 10 })) {
    settingsUrl.searchParams.set("error", "Too many connection attempts. Try again shortly.");
    return redirectAndClearNonce(settingsUrl);
  }

  try {
    const tokens = await exchangeCodeForTokens(code, origin);
    if (!tokens.refresh_token) {
      // Shouldn't happen given access_type=offline&prompt=consent, but if a
      // user somehow lands here without one, we have nothing to store.
      settingsUrl.searchParams.set("error", "Google didn't grant offline access. Try disconnecting any prior Study Lamp access in your Google Account settings, then reconnect.");
      return redirectAndClearNonce(settingsUrl);
    }
    const googleEmail = await getGoogleAccountEmail(tokens.access_token);
    await upsertDriveConnection(verified.uid, { googleEmail, refreshToken: tokens.refresh_token, scope: tokens.scope });
    settingsUrl.searchParams.set("connected", googleEmail);
    return redirectAndClearNonce(settingsUrl);
  } catch (err) {
    logServerError("Drive OAuth callback failed", err);
    settingsUrl.searchParams.set("error", "Something went wrong connecting Google Drive. Please try again.");
    return redirectAndClearNonce(settingsUrl);
  }
}
