import { adminDb } from "@/lib/server/firebase-admin";
import { withDriveAccessToken } from "@/lib/server/driveConnections";
import { fetchDocumentBytes, getFileMetadata } from "@/lib/server/googleDrive";
import { extractDocumentText, MAX_DOCUMENT_BYTES } from "@/lib/server/documentText";
import { hashDocumentText } from "@/lib/server/sourceHash";
import { resolveDocumentText } from "@/lib/server/docTextCache";
import { isSameDriveRevision } from "@/lib/server/documentContentUtils";
import { realBlobDeps } from "@/lib/server/blobRouteDeps";
import { chunkDocId, joinTextChunks } from "@/lib/server/textChunks";
import admin from "firebase-admin";
import type { DocumentFileType } from "@/types";

export interface LoadedDocument {
  id: string;
  title: string;
  fileType: DocumentFileType;
  mimeType?: string;
  driveFileId: string;
  driveConnectionId: string;
  md5Checksum?: string | null;
  modifiedTime?: string | null;
  googleNative?: boolean;
}

export async function getPersonalDocument(uid: string, documentId: string): Promise<LoadedDocument | null> {
  const snap = await adminDb.collection("users").doc(uid).collection("personalDocuments").doc(documentId).get();
  if (!snap.exists) return null;
  const data = snap.data()!;
  return {
    id: snap.id,
    title: data.title,
    fileType: data.fileType,
    mimeType: typeof data.mimeType === "string" ? data.mimeType : undefined,
    driveFileId: data.driveFileId,
    driveConnectionId: data.driveConnectionId,
    md5Checksum: data.md5Checksum ?? null,
    modifiedTime: data.modifiedTime ?? null,
    googleNative: Boolean(data.googleNative),
  };
}

async function readDocumentBytes(response: Response): Promise<Buffer> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_DOCUMENT_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("This document is larger than the 50 MB extraction limit.");
  }
  if (!response.body) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > MAX_DOCUMENT_BYTES) throw new Error("This document is larger than the 50 MB extraction limit.");
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_DOCUMENT_BYTES) {
        await reader.cancel();
        throw new Error("This document is larger than the 50 MB extraction limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

/**
 * Reads the pre-P5 Firestore text cache (content/meta + content/text_N chunks, or the older single content/text doc).
 * Read-only compatibility path: nothing is written to these documents any more.
 */
export async function readLegacyDocumentText(uid: string, documentId: string, revision: { md5Checksum?: string | null; modifiedTime?: string | null }): Promise<string | null> {
  const contentCol = adminDb.collection("users").doc(uid).collection("personalDocuments").doc(documentId).collection("content");
  const [metaSnapshot, legacySnapshot] = await Promise.all([contentCol.doc("meta").get(), contentCol.doc("text").get()]);
  const meta = metaSnapshot.data();
  if (meta && Number.isInteger(meta.chunks) && meta.chunks > 0 && isSameDriveRevision(meta, revision)) {
    const chunkSnapshots = await Promise.all(Array.from({ length: meta.chunks }, (_, i) => contentCol.doc(chunkDocId(i)).get()));
    const parts = chunkSnapshots.map((snapshot) => snapshot.data()?.text);
    if (parts.every((part): part is string => typeof part === "string")) {
      const text = joinTextChunks(parts);
      if (hashDocumentText(text) === meta.textHash) return text;
    }
  }
  const legacy = legacySnapshot.data();
  if (typeof legacy?.text === "string" && isSameDriveRevision(legacy, revision)) return legacy.text;
  return null;
}

/** Deletes every pre-P5 content/* document of one personal document (batches of 400). */
export async function deleteLegacyDocumentText(uid: string, documentId: string): Promise<number> {
  const contentCol = adminDb.collection("users").doc(uid).collection("personalDocuments").doc(documentId).collection("content");
  const refs = await contentCol.listDocuments();
  for (let start = 0; start < refs.length; start += 400) {
    const batch = adminDb.batch();
    refs.slice(start, start + 400).forEach((ref) => batch.delete(ref));
    await batch.commit();
  }
  return refs.length;
}

/**
 * P5: reuses extracted text while Drive's content revision is unchanged. The cache is the "doctext" Drive blob
 * (no Firestore chunk writes). Firestore cost: 1 pointer read (+1 pointer write on a cold extraction) and at most
 * one update of the document's stored revision when it changed.
 */
export async function extractPersonalDocumentText(uid: string, doc: LoadedDocument): Promise<string> {
  const documentRef = adminDb.collection("users").doc(uid).collection("personalDocuments").doc(doc.id);

  return withDriveAccessToken(uid, doc.driveConnectionId, async (accessToken) => {
    const metadata = await getFileMetadata(accessToken, doc.driveFileId);
    const revision = { md5Checksum: metadata.md5Checksum ?? null, modifiedTime: metadata.modifiedTime ?? null };
    const result = await resolveDocumentText({
      async readBlob() { return (await realBlobDeps.get(uid, "doctext", doc.id))?.json ?? null; },
      async writeBlob(blob) { await realBlobDeps.put(uid, "doctext", doc.id, JSON.stringify(blob)); },
      readLegacy: (rev) => readLegacyDocumentText(uid, doc.id, rev),
      async deleteLegacy() { await deleteLegacyDocumentText(uid, doc.id); },
      async extract() {
        const response = await fetchDocumentBytes(accessToken, {
          driveFileId: doc.driveFileId,
          mimeType: doc.mimeType || "application/octet-stream",
          googleNative: Boolean(doc.googleNative),
        });
        if (!response.ok) throw new Error(`Couldn't download "${doc.title}" from Drive (${response.status}).`);
        const bytes = await readDocumentBytes(response);
        const text = await extractDocumentText(bytes, doc.fileType);
        if (!text.trim()) throw new Error(`No readable text could be extracted from "${doc.title}".`);
        return text;
      },
      async recordRevision(rev) {
        // Skip the write when the record already holds this revision (free-tier rule: no write for an unchanged value).
        if (isSameDriveRevision({ md5Checksum: doc.md5Checksum, modifiedTime: doc.modifiedTime }, rev)) return;
        await documentRef.update({ ...rev, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      },
    }, revision);
    return result.text;
  });
}
