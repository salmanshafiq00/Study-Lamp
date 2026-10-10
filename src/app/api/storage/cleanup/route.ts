import { NextResponse } from "next/server";
import { logServerError } from "@/lib/server/logError";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";
import { createAdminCleanupDeps } from "@/lib/server/storageCleanupAdmin";
import { parseCleanupRequest, runCleanup } from "@/lib/server/storageCleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * Deletes ONE batch (up to 400 documents, 50 thumbnails) for the chosen action and reports { deleted, remaining }.
 * The UI shows the exact count from /preview and asks for confirmation first. Drive files are never touched.
 */
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const body = await readJsonObject(req);
  if (!body.ok) return body.response;
  const parsed = parseCleanupRequest(body.body);
  if (!parsed || body.body.confirm !== true) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  try {
    return NextResponse.json(await runCleanup(createAdminCleanupDeps(uid), parsed.action, parsed.params), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logServerError("Storage cleanup failed", error);
    return NextResponse.json({ error: "Cleanup failed. Try again." }, { status: 500 });
  }
}, { scope: "storage:cleanup", limit: 30 });
