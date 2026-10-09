import { adminDb } from "@/lib/server/firebase-admin";
import { blobPointerId, type BlobKind, type BlobPointer, type BlobPointerStore } from "@/lib/server/driveBlobStore";

const blobsRef = (uid: string) => adminDb.collection("users").doc(uid).collection("blobs");
const connectionRef = (uid: string, connectionId: string) => adminDb.collection("users").doc(uid).collection("driveConnections").doc(connectionId);

/** Firestore (Admin SDK) pointer store: users/{uid}/blobs/{kind}__{key} and driveConnections/{id}.appFolderId. Server-only data. */
export const firestoreBlobPointers: BlobPointerStore = {
  async getFolderId(uid, connectionId) {
    const snap = await connectionRef(uid, connectionId).get();
    const value = snap.exists ? snap.data()?.appFolderId : null;
    return typeof value === "string" && value ? value : null;
  },
  async setFolderId(uid, connectionId, folderId) {
    await connectionRef(uid, connectionId).set({ appFolderId: folderId }, { merge: true });
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
