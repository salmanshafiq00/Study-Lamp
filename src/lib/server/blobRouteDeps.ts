import { adminDb } from "@/lib/server/firebase-admin";
import { DriveConnectionError, listDriveConnections, withDriveAccessToken } from "@/lib/server/driveConnections";
import { createDriveBlobApi } from "@/lib/server/driveBlobApi";
import { firestoreBlobPointers } from "@/lib/server/driveBlobPointers";
import { BlobStoreError, deleteBlob, getBlob, putBlob, type BlobStoreDeps } from "@/lib/server/driveBlobStore";
import type { BlobRouteDeps } from "@/lib/server/blobRouteHandlers";

async function withBlobDrive<T>(uid: string, connectionId: string, run: (deps: BlobStoreDeps) => Promise<T>): Promise<T> {
  try {
    return await withDriveAccessToken(uid, connectionId, (accessToken) => run({ api: createDriveBlobApi(accessToken), pointers: firestoreBlobPointers }));
  } catch (err) {
    if (err instanceof DriveConnectionError) throw new BlobStoreError("auth");
    throw err;
  }
}

async function firstActiveConnectionId(uid: string): Promise<string> {
  const connections = await listDriveConnections(uid);
  const active = connections.find((connection) => connection.status === "active");
  if (!active) throw new BlobStoreError("no_connection");
  return active.id;
}

export const realBlobDeps: BlobRouteDeps = {
  async get(uid, kind, key) {
    const pointer = await firestoreBlobPointers.getPointer(uid, kind, key);
    if (!pointer) return null; // nothing stored yet: no Drive call at all
    const blob = await withBlobDrive(uid, pointer.connectionId, (deps) => getBlob(deps, { uid, kind, key }));
    return blob ? { json: blob.json, version: blob.version } : null;
  },
  async put(uid, kind, key, jsonText) {
    const pointer = await firestoreBlobPointers.getPointer(uid, kind, key);
    const connectionId = pointer?.connectionId ?? (await firstActiveConnectionId(uid));
    return withBlobDrive(uid, connectionId, (deps) => putBlob(deps, { uid, connectionId, kind, key, jsonText }));
  },
  async del(uid, kind, key) {
    const pointer = await firestoreBlobPointers.getPointer(uid, kind, key);
    if (!pointer) return false;
    return withBlobDrive(uid, pointer.connectionId, (deps) => deleteBlob(deps, { uid, kind, key }));
  },
  async ownsDocument(uid, documentId) {
    const snap = await adminDb.collection("users").doc(uid).collection("personalDocuments").doc(documentId).get();
    return snap.exists;
  },
};
