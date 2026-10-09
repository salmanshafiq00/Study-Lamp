import {
  collection, doc, getDoc, getDocs, limit, orderBy, query,
  serverTimestamp, setDoc, updateDoc,
} from "@/lib/firestore/instrumented";
import { db } from "@/lib/firebase";
import {
  MAX_FALLBACK_FIRESTORE_ANNOTATION_BYTES, buildAnnotationsBlob, parseAnnotationsBlob, parseDocumentAnnotations, serializeDocumentAnnotations,
} from "@/lib/documentAnnotations";
import { getBlobClient } from "@/lib/blobClientBrowser";
import type { SaveStatus } from "@/lib/blobClient";
import type { PersonalDocument } from "@/types";
import { normalizeReaderProgress, type ReaderFileType, type ReaderProgressInput } from "@/lib/readerProgress";

// users/{ownerId}/personalDocuments/{id} — see the PersonalDocument doc
// comment in src/types/index.ts. Creation happens server-side only, via
// /api/drive/import/file (a document's bytes always come from Drive — see
// Phase 13-16's comments) — this module is read/rename/delete from the
// client, mirroring personalPlaylists.ts's ownerId-explicit pattern.

const documentsCol = (ownerId: string) => collection(db, "users", ownerId, "personalDocuments");

export async function listPersonalDocuments(ownerId: string): Promise<PersonalDocument[]> {
  const snap = await getDocs(query(documentsCol(ownerId), orderBy("createdAt", "desc"), limit(300)));
  return snap.docs.map((d) => ({ id: d.id, ...(d.data() as Omit<PersonalDocument, "id">) }));
}

export async function getPersonalDocumentClient(ownerId: string, documentId: string): Promise<PersonalDocument | null> {
  const snap = await getDoc(doc(db, "users", ownerId, "personalDocuments", documentId));
  return snap.exists() ? ({ id: snap.id, ...(snap.data() as Omit<PersonalDocument, "id">) }) : null;
}

export async function renamePersonalDocument(ownerId: string, documentId: string, title: string): Promise<void> {
  await updateDoc(doc(db, "users", ownerId, "personalDocuments", documentId), { title: title.trim(), updatedAt: serverTimestamp() });
}

export async function updatePersonalDocumentClassification(
  ownerId: string,
  documentId: string,
  classification: { categoryId: string | null; tagIds: string[] },
): Promise<void> {
  await updateDoc(doc(db, "users", ownerId, "personalDocuments", documentId), {
    ...classification,
    updatedAt: serverTimestamp(),
  });
}

/** Saves the reading position for a PDF, Word or Excel document. The shape is normalised
 *  (clamped, only the fields that belong to `fileType`) so it always satisfies the Firestore rules. */
export async function updatePersonalDocumentReadingProgress(
  ownerId: string,
  documentId: string,
  progress: ReaderProgressInput,
  fileType: ReaderFileType = "pdf",
): Promise<void> {
  await updateDoc(doc(db, "users", ownerId, "personalDocuments", documentId), {
    readerProgress: { ...normalizeReaderProgress(progress, fileType), updatedAt: serverTimestamp() },
  });
}

function documentAnnotationsRef(ownerId: string, documentId: string) {
  return doc(db, "users", ownerId, "personalDocuments", documentId, "annotations", "main");
}

async function readLegacyAnnotations(ownerId: string, documentId: string): Promise<unknown[]> {
  const snapshot = await getDoc(documentAnnotationsRef(ownerId, documentId));
  return snapshot.exists() ? parseDocumentAnnotations(snapshot.data()?.annotationsJson) : [];
}

/**
 * P4: annotations live in the user's Drive ("Study Lamp data"), read through IndexedDB. Firestore is only read for
 * documents not migrated yet (or when Drive is unavailable); the result is then cached locally so it is read once.
 */
export async function getPersonalDocumentAnnotations(
  ownerId: string,
  documentId: string,
  onRemoteUpdate?: (annotations: unknown[]) => void,
): Promise<unknown[]> {
  const client = getBlobClient(ownerId);
  const result = await client.readThrough("annotations", documentId, onRemoteUpdate ? (json) => onRemoteUpdate(parseAnnotationsBlob(json)) : undefined);
  if (result.source === "local" || result.source === "remote") return parseAnnotationsBlob(result.json);
  const legacy = await readLegacyAnnotations(ownerId, documentId);
  if (result.source === "none") await client.seedLocal("annotations", documentId, { version: 1, annotations: legacy });
  return legacy;
}

export function getAnnotationSaveStatus(ownerId: string, documentId: string): SaveStatus {
  return getBlobClient(ownerId).getStatus("annotations", documentId);
}

export function subscribeAnnotationSaveStatus(ownerId: string, documentId: string, listener: (status: SaveStatus) => void): () => void {
  const id = getBlobClient(ownerId).idOf("annotations", documentId);
  return getBlobClient(ownerId).subscribe((changedId, status) => { if (changedId === id) listener(status); });
}

export async function savePersonalDocumentAnnotations(
  ownerId: string,
  documentId: string,
  annotations: unknown[],
): Promise<void> {
  const blob = buildAnnotationsBlob(annotations); // throws above 2 MB
  // Saved to IndexedDB at once, sent to Drive at most every 3 s. If Drive is not connected (or needs reconnecting),
  // fall back to the old Firestore copy ONLY when it is small; otherwise the status says "offline copy only".
  await getBlobClient(ownerId).write("annotations", documentId, blob, async (json) => {
    const annotationsJson = serializeDocumentAnnotations(parseAnnotationsBlob(json));
    if (new TextEncoder().encode(annotationsJson).byteLength > MAX_FALLBACK_FIRESTORE_ANNOTATION_BYTES) return false;
    await setDoc(documentAnnotationsRef(ownerId, documentId), { annotationsJson, updatedAt: serverTimestamp() }, { merge: true });
    return true;
  });
}

export async function deletePersonalDocument(idToken: string, documentId: string): Promise<void> {
  // Only removes the Study Lamp record (and its quiz/content/annotations
  // subcollections) — the underlying Drive file is left untouched, matching
  // every other Drive-import surface's "we don't own your Drive" stance.
  // Goes through the server because Firestore does not cascade-delete
  // subcollections and the client rules deny reads/writes on `content`.
  const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${idToken}` },
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed (${res.status})`);
  }
}
