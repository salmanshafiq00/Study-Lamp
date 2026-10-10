import { NextResponse } from "next/server";
import { getAccessTokenForConnection, DriveConnectionError } from "@/lib/server/driveConnections";
import { logServerError } from "@/lib/server/logError";
import { isValidDriveConnectionId } from "@/lib/server/googleDrive";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { getGoogleClient, pickerAppIdFromClientId } from "@/lib/server/googleClientConfig";

// Returns a short-lived (~1hr) Drive access token, scoped to drive.file, for
// client-side use by the Google Picker only (Phase 14) — the Picker widget
// itself requires a browser-side OAuth token to know which account's files
// to show. This is *not* the same as exposing the long-lived refresh token:
// it expires quickly and is never persisted client-side (not localStorage,
// not React state that outlives the Picker session).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withAuthedRoute(async ({ uid, req }) => {
  const connectionId = req.nextUrl.searchParams.get("connectionId");
  if (!isValidDriveConnectionId(connectionId)) return NextResponse.json({ error: "A valid connectionId is required." }, { status: 400 });

  try {
    const accessToken = await getAccessTokenForConnection(uid, connectionId);
    // The Picker's App ID must be the Google Cloud project NUMBER that owns the OAuth client that minted
    // this token. That number is the digits before the first "-" in the client id, so derive it here
    // instead of relying on the Firebase sender id (which differs when the OAuth client lives in another project).
    const appId = pickerAppIdFromClientId(getGoogleClient()?.clientId);
    return NextResponse.json({ accessToken, appId });
  } catch (err) {
    if (err instanceof DriveConnectionError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 409 });
    }
    logServerError("Failed to mint Drive access token", err);
    return NextResponse.json({ error: "Couldn't reach Google Drive." }, { status: 502 });
  }
}, { scope: "drive:access-token" });