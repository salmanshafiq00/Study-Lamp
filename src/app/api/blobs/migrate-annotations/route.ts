import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { logServerError } from "@/lib/server/logError";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";
import { MIGRATION_BATCH_SIZE, migrateOneAnnotation } from "@/lib/server/annotationMigration";
import { realBlobDeps } from "@/lib/server/blobRouteDeps";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const options = { scope: "blob", preset: "blob" } as const;
const NO_STORE = { "Cache-Control": "private, no-store" };
const legacyRef = (uid: string, documentId: string) =>
  adminDb.collection("users").doc(uid).collection("personalDocuments").doc(documentId).collection("annotations").doc("main");

/** Lists documents that still have a legacy Firestore annotation copy (for the confirm dialog). One-off scan, reads only. */
export const GET = withAuthedRoute(async ({ uid }) => {
  try {
    const docs = await adminDb.collection("users").doc(uid).collection("personalDocuments").select().limit(300).get();
    const candidates: string[] = [];
    for (let index = 0; index < docs.docs.length; index += 100) {
      const slice = docs.docs.slice(index, index + 100);
      const snaps = await adminDb.getAll(...slice.map((snap) => legacyRef(uid, snap.id)));
      snaps.forEach((snap, offset) => { if (snap.exists) candidates.push(slice[offset].id); });
    }
    return NextResponse.json({ documentIds: candidates }, { headers: NO_STORE });
  } catch (err) {
    logServerError("Annotation migration scan failed", err);
    return NextResponse.json({ error: "Couldn't check your annotations." }, { status: 500 });
  }
}, options);

/** Moves up to 5 documents per call: write to Drive, read back, compare hash, THEN delete the legacy Firestore copy. */
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const ids = parsed.body.documentIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > MIGRATION_BATCH_SIZE || !ids.every((id) => typeof id === "string" && ID.test(id))) {
    return NextResponse.json({ error: `Send 1 to ${MIGRATION_BATCH_SIZE} valid document ids.` }, { status: 400 });
  }
  try {
    const results: Record<string, string> = {};
    for (const documentId of ids as string[]) {
      if (!(await realBlobDeps.ownsDocument(uid, documentId))) { results[documentId] = "skipped_none"; continue; }
      results[documentId] = await migrateOneAnnotation({
        async readLegacy(id) {
          const snap = await legacyRef(uid, id).get();
          if (!snap.exists) return null;
          const json = snap.get("annotationsJson");
          return typeof json === "string" ? json : "[]";
        },
        async putBlob(id, text) { await realBlobDeps.put(uid, "annotations", id, text); },
        async readBackBlob(id) {
          const blob = await realBlobDeps.get(uid, "annotations", id);
          return blob ? JSON.stringify(blob.json) : null;
        },
        async deleteLegacy(id) { await legacyRef(uid, id).delete(); },
      }, documentId);
    }
    const values = Object.values(results);
    return NextResponse.json({
      moved: values.filter((status) => status === "moved" || status === "skipped_empty").length,
      failed: values.filter((status) => status === "failed").length,
      results,
    }, { headers: NO_STORE });
  } catch (err) {
    logServerError("Annotation migration failed", err);
    return NextResponse.json({ error: "Migration failed." }, { status: 500 });
  }
}, options);
