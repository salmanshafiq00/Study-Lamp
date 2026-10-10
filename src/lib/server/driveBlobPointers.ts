import { adminDb } from "@/lib/server/firebase-admin";
import { resolveDriveConnectionId } from "@/lib/server/driveConnections";
import { blobPointerId, type BlobKind, type BlobPointer, type BlobPointerStore } from "@/lib/server/driveBlobStore";

const blobsRef = (uid: string) => adminDb.collection("users").doc(uid).collection("blobs");
/** The doc that holds `appFolderId` for a connection id: the unified googleConnections doc when the id resolves to
 *  one (a migrated or new connection), otherwise the legacy driveConnections doc. Null when the id is unknown. */
async function folderDocRef(uid: string, connectionId: string) {
  const resolved = await resolveDriveConnectionId(uid, connectionId);
  if (!resolved) return null;
  const collection = resolved.kind === "google" ? "googleConnections" : "driveConnections";
  return adminDb.collection("users").doc(uid).collection(collection).doc(resolved.id);
}

/** Firestore (Admin SDK) pointer store: users/{uid}/blobs/{kind}__{key} and the connection doc's appFolderId
 *  (googleConnections/{id} or driveConnections/{id}, see folderDocRef). Server-only data. */
export const firestoreBlobPointers: BlobPointerStore = {
  async getFolderId(uid, connectionId) {
    const ref = await folderDocRef(uid, connectionId);
    if (!ref) return null;
    const snap = await ref.get();
    const value = snap.exists ? snap.data()?.appFolderId : null;
    return typeof value === "string" && value ? value : null;
  },
  async setFolderId(uid, connectionId, folderId) {
    const ref = await folderDocRef(uid, connectionId);
    if (!ref) return; // unknown connection: nothing to store the folder on
    await ref.set({ appFolderId: folderId }, { merge: true });
  },
  async getPointer(uid, kind: BlobKind, key) {
    const snap = await blobsRef(uid).doc(blobPointerId(kind, key)).get();
    if (!snap.exists) return null;
    const data = snap.data() ?? {};
    if (typeof data.fileId !== "string" || typeof data.connectionId !== "string") return null;
    return {
      fileId: data.fileId,
      bytes: typeof data.bytes === "number" ? data.bytes : 0,
      version: typeof data.version === "string" ? data.version : null,
      connectionId: data.connectionId,
      updatedAt: typeof data.updatedAt === "number" ? data.updatedAt : 0,
    };
  },
  async setPointer(uid, kind, key, pointer: BlobPointer) {
    await blobsRef(uid).doc(blobPointerId(kind, key)).set(pointer);
  },
  async deletePointer(uid, kind, key) {
    await blobsRef(uid).doc(blobPointerId(kind, key)).delete();
  },
};
