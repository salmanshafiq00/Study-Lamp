import { NextResponse } from "next/server";
import { logServerError } from "@/lib/server/logError";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";
import { createAdminCleanupDeps } from "@/lib/server/storageCleanupAdmin";
import { parseCleanupRequest, previewCleanup } from "@/lib/server/storageCleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Exact number of items a cleanup would delete. Performs no writes and no deletes. */
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const body = await readJsonObject(req);
  if (!body.ok) return body.response;
  const parsed = parseCleanupRequest(body.body);
  if (!parsed) return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  try {
    return NextResponse.json(await previewCleanup(createAdminCleanupDeps(uid), parsed.action, parsed.params), { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logServerError("Cleanup preview failed", error);
    return NextResponse.json({ error: "Couldn't count the items." }, { status: 500 });
  }
}, { scope: "storage:preview", limit: 30 });
