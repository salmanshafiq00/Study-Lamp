import { NextResponse } from "next/server";
import { logServerError } from "@/lib/server/logError";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { loadStorageCounts } from "@/lib/server/storageCleanupAdmin";
import { FREE_PLAN_NOTE } from "@/lib/server/storageCleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Counts per collection through count aggregations (cheap, no document downloads). Read-only. */
export const GET = withAuthedRoute(async ({ uid }) => {
  try {
    return NextResponse.json({ counts: await loadStorageCounts(uid), note: FREE_PLAN_NOTE }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logServerError("Storage health failed", error);
    return NextResponse.json({ error: "Couldn't load storage counts." }, { status: 500 });
  }
}, { scope: "storage:health", limit: 20 });
