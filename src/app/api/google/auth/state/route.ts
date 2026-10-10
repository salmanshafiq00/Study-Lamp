import crypto from "crypto";
import { NextResponse } from "next/server";
import { buildWorkspaceAuthUrl, isWorkspaceConfigured, signWorkspaceState, WORKSPACE_NONCE_COOKIE } from "@/lib/server/googleWorkspaceAuth";
import { isGoogleFeature } from "@/lib/server/googleScopes";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withAuthedRoute(async ({ uid, req }) => {
  if (!isWorkspaceConfigured()) {
    return NextResponse.json({ error: "Google Workspace isn't configured on this deployment yet." }, { status: 501 });
  }

  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;

  const requested: unknown = parsed.body.features;
  // Must be an array of 1-3 values, each exactly "drive", "calendar" or "tasks", with
  // no duplicates. Anything else (wrong type, unknown value, too many) -> 400.
  const invalid = NextResponse.json({ error: "Provide one to three Google features: drive, calendar or tasks." }, { status: 400 });
  if (!Array.isArray(requested) || requested.length < 1 || requested.length > 3 || !requested.every(isGoogleFeature)) {
    return invalid;
  }
  const features = Array.from(new Set(requested));
  if (features.length !== requested.length) return invalid;

  const nonce = crypto.randomBytes(32).toString("base64url");
  const state = signWorkspaceState(uid, nonce, features);
  const response = NextResponse.json({ url: buildWorkspaceAuthUrl(req.nextUrl.origin, state, features) });
  response.cookies.set(WORKSPACE_NONCE_COOKIE, nonce, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    path: "/api/google/auth",
    maxAge: 600,
  });
  return response;
}, { scope: "google:auth-state", preset: "authSensitive" });
