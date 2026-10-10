import { NextResponse } from "next/server";
import { migrateDriveConnections, pendingLegacyCount } from "@/lib/server/driveMigration";
import { firestoreMigrationStore, realMigrationDeps } from "@/lib/server/driveMigrationDeps";
import { logServerError } from "@/lib/server/logError";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET: how many old Drive connections still need moving (two bounded reads, no writes).
export const GET = withAuthedRoute(async ({ uid }) => {
  const [legacy, google] = await Promise.all([firestoreMigrationStore.listLegacy(uid), firestoreMigrationStore.listGoogle(uid)]);
  return NextResponse.json({ pending: pendingLegacyCount(legacy, google) });
}, { scope: "google:migrate-drive-status", limit: 20 });

// POST {confirm:true}: runs the migration. Never deletes anything; old docs are only marked after verification.
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  if (parsed.body.confirm !== true) {
    return NextResponse.json({ error: "Confirm the migration first." }, { status: 400 });
  }
  try {
    const report = await migrateDriveConnections(realMigrationDeps, uid);
    return NextResponse.json({ counts: report.counts }); // counts only: no ids, e-mails or tokens
  } catch (error) {
    logServerError("Drive migration failed", error);
    return NextResponse.json({ error: "Couldn't move your Drive connections. Nothing was deleted. Try again." }, { status: 500 });
  }
}, { scope: "google:migrate-drive", limit: 5 });
