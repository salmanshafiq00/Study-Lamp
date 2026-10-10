import { NextResponse } from "next/server";
import { cleanupLegacyDriveConnections, planLegacyCleanup } from "@/lib/server/legacyDriveCleanup";
import { firestoreCleanupStore } from "@/lib/server/driveMigrationDeps";
import { logServerError } from "@/lib/server/logError";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET: counts only (two bounded reads, no writes).
export const GET = withAuthedRoute(async ({ uid }) => {
  const [legacy, google] = await Promise.all([firestoreCleanupStore.listLegacy(uid), firestoreCleanupStore.listGoogle(uid)]);
  const plan = planLegacyCleanup(legacy, google);
  return NextResponse.json({ deletable: plan.deletable.length, blocked: plan.blocked });
}, { scope: "google:cleanup-drive-status", limit: 20 });

// POST {confirm:true}: deletes ONLY old driveConnections docs whose unified twin links back. Never touches
// googleConnections, never revokes a token (the grant is shared), never touches imported documents.
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  if (parsed.body.confirm !== true) return NextResponse.json({ error: "Confirm the clean-up first." }, { status: 400 });
  try {
    return NextResponse.json(await cleanupLegacyDriveConnections(firestoreCleanupStore, uid));
  } catch (error) {
    logServerError("Legacy Drive clean-up failed", error);
    return NextResponse.json({ error: "Couldn't clean up the old Drive records. Nothing else was changed." }, { status: 500 });
  }
}, { scope: "google:cleanup-drive", limit: 5 });
