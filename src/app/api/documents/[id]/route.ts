import { NextResponse } from "next/server";
import { adminDb } from "@/lib/server/firebase-admin";
import { logServerError } from "@/lib/server/logError";
import { withAuthedRoute } from "@/lib/server/routeHelpers";
import { removeThumbnailIfUnreferenced } from "@/lib/server/driveThumbnailPrune";
import { realBlobDeps } from "@/lib/server/blobRouteDeps";

interface RouteParams {
  params: { id: string };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Recursive deletes touch several subcollections; adjust to the deployment plan limit.
export const maxDuration = 60;

const DOCUMENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Removes a Study Materials record and everything stored under it
 * (quiz cache, extracted-text cache, annotations). Firestore does NOT delete
 * subcollections when the parent is deleted, so a plain client deleteDoc would
 * leave them behind as orphans. The Drive file itself is never touched.
 */
export const DELETE = withAuthedRoute<RouteParams["params"]>(async ({ uid, params }) => {
  const documentId = params.id;
  if (!DOCUMENT_ID_PATTERN.test(documentId)) {
    return NextResponse.json({ error: "Invalid document id." }, { status: 400 });
  }

  try {
    const userRef = adminDb.collection("users").doc(uid);
    const documentRef = userRef.collection("personalDocuments").doc(documentId);
    const snap = await documentRef.get();
    if (!snap.exists) return NextResponse.json({ error: "Document not found." }, { status: 404 });

    const driveFileId = snap.get("driveFileId");
    const driveConnectionId = snap.get("driveConnectionId");

    // Parent document + quiz/, content/, annotations/ subcollections.
    await adminDb.recursiveDelete(documentRef);

    // Per-document study data saved under the "d_" key prefix (see notes.ts).
    // Best effort: a failure here must not turn a successful removal into an error.
    await Promise.allSettled([
      userRef.collection("summaries").doc(`d_${documentId}`).delete(),
      userRef.collection("notes").doc(`d_${documentId}`).delete(),
      // P4: trash this document's Drive blobs (never a hard delete) and drop their pointers.
      realBlobDeps.del(uid, "annotations", documentId),
      realBlobDeps.del(uid, "doctext", documentId),
      realBlobDeps.del(uid, "summary", `d_${documentId}`),
      realBlobDeps.del(uid, "note", `d_${documentId}`),
      // The server-only thumbnail goes too, unless another record still uses the same Drive file.
      typeof driveFileId === "string" && typeof driveConnectionId === "string"
        ? removeThumbnailIfUnreferenced(uid, driveConnectionId, driveFileId)
        : Promise.resolve(false),
    ]);

    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    logServerError("Document delete failed", error);
    return NextResponse.json({ error: "Couldn't remove this document." }, { status: 500 });
  }
}, { scope: "document-delete", limit: 60, tooManyMessage: "Too many requests. Please slow down.", retryAfterSeconds: null });
