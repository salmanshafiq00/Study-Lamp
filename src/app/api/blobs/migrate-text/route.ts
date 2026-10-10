import { NextResponse } from "next/server";
import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { logServerError } from "@/lib/server/logError";
import { readJsonObject, withAuthedRoute } from "@/lib/server/routeHelpers";
import { realBlobDeps } from "@/lib/server/blobRouteDeps";
import { deleteLegacyDocumentText, readLegacyDocumentText } from "@/lib/server/documentContent";
import {
  COLLECTION_KIND, LARGE_MIGRATION_BATCH, isOversizedInline, migrateOneContent, migrateOneField,
  type LargeMigrationStatus, type TextCollection,
} from "@/lib/server/largeTextMigration";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const options = { scope: "blob", preset: "blob" } as const;
const NO_STORE = { "Cache-Control": "private, no-store" };
const SCAN_LIMIT = 200;
const COLLECTIONS: TextCollection[] = ["notes", "summaries", "transcripts"];
const userRef = (uid: string) => adminDb.collection("users").doc(uid);

/**
 * Read-only scan for the confirm dialog. Bounded: at most 200 docs per text collection and 300 personal documents
 * (one-off, user-triggered). Returns what would be moved; nothing is written.
 */
export const GET = withAuthedRoute(async ({ uid }) => {
  try {
    const fields: Array<{ collection: TextCollection; id: string }> = [];
    for (const collection of COLLECTIONS) {
      const snap = await userRef(uid).collection(collection).limit(SCAN_LIMIT).get();
      snap.docs.forEach((doc) => { if (isOversizedInline(doc.data())) fields.push({ collection, id: doc.id }); });
    }
    const docs = await userRef(uid).collection("personalDocuments").select().limit(300).get();
    const contentDocumentIds: string[] = [];
    for (let i = 0; i < docs.docs.length; i += 100) {
      const slice = docs.docs.slice(i, i + 100);
      const metas = await adminDb.getAll(...slice.map((d) => d.ref.collection("content").doc("meta")), ...slice.map((d) => d.ref.collection("content").doc("text")));
      slice.forEach((d, index) => { if (metas[index].exists || metas[slice.length + index].exists) contentDocumentIds.push(d.id); });
    }
    return NextResponse.json({ fields: fields.slice(0, 500), contentDocumentIds }, { headers: NO_STORE });
  } catch (err) {
    logServerError("Large text migration scan failed", err);
    return NextResponse.json({ error: "Couldn't check your saved text." }, { status: 500 });
  }
}, options);

/** Moves up to 5 items per call. Body: { fields?: [{collection,id}], contentDocumentIds?: string[] } (5 items total). */
export const POST = withAuthedRoute(async ({ uid, req }) => {
  const parsed = await readJsonObject(req);
  if (!parsed.ok) return parsed.response;
  const fields = Array.isArray(parsed.body.fields) ? parsed.body.fields : [];
  const contentIds = Array.isArray(parsed.body.contentDocumentIds) ? parsed.body.contentDocumentIds : [];
  const validFields = fields.every((f: unknown) => !!f && typeof f === "object"
    && COLLECTIONS.includes((f as { collection: TextCollection }).collection) && ID.test(String((f as { id: unknown }).id)));
  if (!validFields || !contentIds.every((id: unknown) => typeof id === "string" && ID.test(id))
    || fields.length + contentIds.length === 0 || fields.length + contentIds.length > LARGE_MIGRATION_BATCH) {
    return NextResponse.json({ error: `Send 1 to ${LARGE_MIGRATION_BATCH} valid items.` }, { status: 400 });
  }

  try {
    const results: Record<string, LargeMigrationStatus> = {};
    for (const item of fields as Array<{ collection: TextCollection; id: string }>) {
      const kind = COLLECTION_KIND[item.collection];
      const ref = userRef(uid).collection(item.collection).doc(item.id);
      results[`${item.collection}/${item.id}`] = await migrateOneField({
        async readInline() { const d = (await ref.get()).data(); return d && !d.blobKind && typeof d.content === "string" ? d.content : null; },
        async putBlob(text) { await realBlobDeps.put(uid, kind, item.id, text); },
        async readBack() { const b = await realBlobDeps.get(uid, kind, item.id); return b ? JSON.stringify(b.json) : null; },
        async writePointer(pointer) { await ref.set({ content: pointer.preview, ...pointer, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }); },
      }, kind, item.id);
    }
    for (const documentId of contentIds as string[]) {
      if (!(await realBlobDeps.ownsDocument(uid, documentId))) { results[`content/${documentId}`] = "skipped"; continue; }
      const docRef = userRef(uid).collection("personalDocuments").doc(documentId);
      results[`content/${documentId}`] = await migrateOneContent({
        async readLegacyText() {
          const [metaSnap, textSnap] = await Promise.all([docRef.collection("content").doc("meta").get(), docRef.collection("content").doc("text").get()]);
          const m = metaSnap.data() ?? textSnap.data();
          if (!m) return null;
          const revision = { md5Checksum: typeof m.md5Checksum === "string" ? m.md5Checksum : null, modifiedTime: typeof m.modifiedTime === "string" ? m.modifiedTime : null };
          const text = await readLegacyDocumentText(uid, documentId, revision);
          if (text === null) return null;
          const { hashText } = await import("@/lib/server/docTextCache");
          return { text, revision, textHash: hashText(text) };
        },
        async putBlob(text) { await realBlobDeps.put(uid, "doctext", documentId, text); },
        async readBack() { const b = await realBlobDeps.get(uid, "doctext", documentId); return b ? JSON.stringify(b.json) : null; },
        async deleteLegacy() { await deleteLegacyDocumentText(uid, documentId); },
      });
    }
    const values = Object.values(results);
    return NextResponse.json({ moved: values.filter((v) => v === "moved").length, failed: values.filter((v) => v === "failed").length, results }, { headers: NO_STORE });
  } catch (err) {
    logServerError("Large text migration failed", err);
    return NextResponse.json({ error: "Migration failed." }, { status: 500 });
  }
}, options);
