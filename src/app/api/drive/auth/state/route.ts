import crypto from "crypto";
import { NextResponse } from "next/server";
import { buildAuthUrl, signDriveState, isDriveConfigured } from "@/lib/server/googleDrive";
import { withAuthedRoute } from "@/lib/server/routeHelpers";

// Step 1 of the OAuth flow (Phase 13): the browser calls this (authenticated,
// normal fetch with an Authorization header) to get a short-lived signed
// state token, then builds the Google auth URL itself and navigates the
// whole page there. See src/lib/driveClient.ts.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withAuthedRoute(async ({ uid, req }) => {
  if (!isDriveConfigured()) {
    return NextResponse.json(
      { error: "Google Drive isn't configured on this deployment yet (missing GOOGLE_CLIENT_ID/SECRET and GOOGLE_DRIVE_OAUTH_STATE_SECRET)." },
      { status: 501 }
    );
  }

  const nonce = crypto.randomBytes(32).toString("base64url");
  const state = signDriveState(uid, nonce);
  const response = NextResponse.json({ url: buildAuthUrl(req.nextUrl.origin, state) });
  response.cookies.set("sl_drive_nonce", nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/drive/auth",
    maxAge: 600,
  });
  return response;
}, { scope: "drive:auth-state", limit: 10 });
