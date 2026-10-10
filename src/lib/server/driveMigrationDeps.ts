import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { decryptApiKey } from "@/lib/server/aiEncryption";
import { getFileMetadata } from "@/lib/server/googleDrive";
import { refreshWorkspaceAccessToken } from "@/lib/server/googleWorkspaceAuth";
import { logServerError } from "@/lib/server/logError";
import type { DocRow, MigrationDeps, MigrationStore } from "@/lib/server/driveMigration";
import type { CleanupStore } from "@/lib/server/legacyDriveCleanup";

// Server-only. Real Firestore + Google wiring for driveMigration.ts. The pure rules live there and are unit-tested.

const legacyRef = (uid: string) => adminDb.collection("users").doc(uid).collection("driveConnections");
const googleRef = (uid: string) => adminDb.collection("users").doc(uid).collection("googleConnections");

export const firestoreMigrationStore: MigrationStore = {
  async listLegacy(uid) {
    return (await legacyRef(uid).limit(50).get()).docs.map((doc): DocRow => ({ id: doc.id, data: doc.data() }));
  },
  async listGoogle(uid) {
    return (await googleRef(uid).limit(50).get()).docs.map((doc): DocRow => ({ id: doc.id, data: doc.data() }));
  },
  async createGoogle(uid, data) {
    const ref = googleRef(uid).doc();
    await ref.set(data);
    return ref.id;
  },
  async updateGoogle(uid, id, patch) {
    await googleRef(uid).doc(id).update(patch);
  },
  async updateLegacy(uid, id, patch) {
    await legacyRef(uid).doc(id).update(patch);
  },
};

/** Refreshes the token with the UNIFIED client and, when a Study Lamp data folder is known, reads that folder with it. */
async function verifyToken(_uid: string, encryptedRefreshToken: string, appFolderId: string | null): Promise<boolean> {
  try {
    const { accessToken } = await refreshWorkspaceAccessToken(decryptApiKey(encryptedRefreshToken));
    if (appFolderId) await getFileMetadata(accessToken, appFolderId);
    return true;
  } catch (error) {
    logServerError("Drive migration verification failed", error); // label only; the helper never logs response bodies or tokens
    return false;
  }
}

/** G7: same collections, plus the one delete the cleanup button is allowed to do (old driveConnections docs only). */
export const firestoreCleanupStore: CleanupStore = {
  listLegacy: firestoreMigrationStore.listLegacy,
  listGoogle: firestoreMigrationStore.listGoogle,
  async deleteLegacy(uid, id) {
    await legacyRef(uid).doc(id).delete();
  },
};

export const realMigrationDeps: MigrationDeps = {
  store: firestoreMigrationStore,
  verify: verifyToken,
  now: () => admin.firestore.FieldValue.serverTimestamp(),
};
