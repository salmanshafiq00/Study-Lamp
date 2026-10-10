import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { encryptApiKey, decryptApiKey } from "@/lib/server/aiEncryption";
import { refreshAccessToken, revokeToken } from "@/lib/server/googleDrive";
import { isGoogleAuthInvalid } from "@/lib/server/googleOAuth";
import { refreshWorkspaceAccessToken } from "@/lib/server/googleWorkspaceAuth";
import {
  googleDocHasDrive,
  planDriveDisconnect,
  resolveDriveConnection,
  selectDriveListing,
  type ResolvedDriveConnection,
  type ResolverStore,
} from "@/lib/server/driveConnectionResolver";
import { DriveTokenCache } from "@/lib/server/driveTokenCache";
import { runWithDriveToken } from "@/lib/server/driveRequest";
import type { DriveConnectionSummary } from "@/types";

// Step G5: a Drive connection id can now be a legacy id (users/{uid}/driveConnections/{id}) or a unified id
// (users/{uid}/googleConnections/{id} with "drive" in grantedScopes). Every helper in this file resolves the id
// through driveConnectionResolver.ts, so callers (import, stream, backup, blob store ...) keep their signatures and
// documents that store the old `driveConnectionId` keep opening without being rewritten.
//
// Server-only. Mirrors src/lib/server/aiConnections.ts exactly: writes go to
// users/{uid}/driveConnections/{id} via the Admin SDK, which is the only way
// in — firestore.rules denies this subcollection to the client SDK entirely
// (see the "driveConnections" match block), so every check here is the only
// backstop, same reasoning as the AI connections module.

const accessTokenCache = new DriveTokenCache(500, 60_000);
const lastUsedWriteAt = new Map<string, number>();
const LAST_USED_WRITE_INTERVAL_MS = 15 * 60_000;

function accessTokenCacheKey(uid: string, connectionId: string): string {
  return `${uid}:${connectionId}`;
}

export function invalidateAccessToken(uid: string, connectionId: string): void {
  const key = accessTokenCacheKey(uid, connectionId);
  accessTokenCache.invalidate(key);
  lastUsedWriteAt.delete(key);
}

export async function withDriveAccessToken<T>(
  uid: string,
  connectionId: string,
  operation: (accessToken: string) => Promise<T>,
  tokenProvider: () => Promise<string> = () => getAccessTokenForConnection(uid, connectionId),
): Promise<T> {
  return runWithDriveToken(
    tokenProvider,
    () => invalidateAccessToken(uid, connectionId),
    operation,
  );
}

function connectionsRef(uid: string) {
  return adminDb.collection("users").doc(uid).collection("driveConnections");
}

function googleConnectionsRef(uid: string) {
  return adminDb.collection("users").doc(uid).collection("googleConnections");
}

/** Firestore-backed lookups for the resolver. */
export const firestoreResolverStore: ResolverStore = {
  getGoogle: (uid, id) => googleConnectionsRef(uid).doc(id).get(),
  getLegacy: (uid, id) => connectionsRef(uid).doc(id).get(),
  async findGoogleByLegacyId(uid, legacyId) {
    const found = await googleConnectionsRef(uid).where("legacyDriveConnectionId", "==", legacyId).limit(1).get();
    return found.empty ? null : found.docs[0];
  },
};

export function resolveDriveConnectionId(uid: string, connectionId: string): Promise<ResolvedDriveConnection | null> {
  return resolveDriveConnection(firestoreResolverStore, uid, connectionId);
}

function toIso(value: admin.firestore.Timestamp | null | undefined): string | null {
  return value ? value.toDate().toISOString() : null;
}

function toSummary(id: string, data: FirebaseFirestore.DocumentData): DriveConnectionSummary {
  return {
    id,
    googleEmail: data.googleEmail,
    status: data.status ?? "active",
    createdAt: toIso(data.createdAt),
    lastUsedAt: toIso(data.lastUsedAt),
  };
}

function createdAtMillis(data: FirebaseFirestore.DocumentData): number {
  return typeof data.createdAt?.toMillis === "function" ? data.createdAt.toMillis() : 0;
}

/** Legacy connections not yet migrated + unified connections with Drive on, oldest first (two bounded reads). */
export async function listDriveConnections(uid: string): Promise<DriveConnectionSummary[]> {
  const [legacySnap, googleSnap] = await Promise.all([connectionsRef(uid).limit(50).get(), googleConnectionsRef(uid).limit(50).get()]);
  const listed = selectDriveListing(
    legacySnap.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
    googleSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() })),
  );
  return listed
    .sort((left, right) => createdAtMillis(left.data) - createdAtMillis(right.data))
    .map((item) => toSummary(item.id, item.data));
}

export async function getDriveConnectionSummary(uid: string, connectionId: string): Promise<DriveConnectionSummary | null> {
  const resolved = await resolveDriveConnectionId(uid, connectionId);
  if (!resolved) return null;
  if (resolved.kind === "legacy") {
    const snap = await connectionsRef(uid).doc(resolved.id).get();
    return snap.exists ? toSummary(connectionId, snap.data()!) : null;
  }
  if (!resolved.hasDrive) return null;
  const snap = await googleConnectionsRef(uid).doc(resolved.id).get();
  return snap.exists ? toSummary(connectionId, snap.data()!) : null;
}

/** Disconnects a Drive account. What that means depends on where the token lives (see planDriveDisconnect):
 *  a legacy or Drive-only connection is deleted and its token revoked at Google (best effort, a failure there never
 *  blocks removing it here); a unified connection that Calendar or Tasks also use only has Drive switched off, so the
 *  token stays for the other features. Files already imported keep their driveFileId/driveConnectionId, so playback
 *  fails with a clear "reconnect" error rather than pointing at a connection that no longer exists. */
export async function deleteDriveConnection(uid: string, connectionId: string): Promise<boolean> {
  const resolved = await resolveDriveConnectionId(uid, connectionId);
  if (!resolved) return false;

  const googleSnap = resolved.kind === "google" ? await googleConnectionsRef(uid).doc(resolved.id).get() : null;
  if (resolved.kind === "google" && !googleSnap?.exists) return false;
  const action = planDriveDisconnect(resolved, googleSnap?.data());
  invalidateAccessToken(uid, connectionId);
  if (resolved.kind === "google") invalidateAccessToken(uid, resolved.id);

  const deleteLegacyTwin = async (legacyId: string | null) => {
    if (!legacyId) return;
    invalidateAccessToken(uid, legacyId);
    // The old token is no longer used. Deleting the doc stops the resolver from ever falling back to it.
    await connectionsRef(uid).doc(legacyId).delete().catch(() => undefined);
  };

  if (action.kind === "delete_legacy") {
    const ref = connectionsRef(uid).doc(action.legacyId);
    const snap = await ref.get();
    if (!snap.exists) return false;
    await revokeToken(decryptApiKey(snap.data()!.encryptedRefreshToken));
    await ref.delete();
    return true;
  }

  const ref = googleConnectionsRef(uid).doc(action.googleId);
  if (action.kind === "drop_drive_feature") {
    const scopes = Array.isArray(googleSnap?.data()?.grantedScopes) ? (googleSnap!.data()!.grantedScopes as unknown[]) : [];
    await ref.update({
      grantedScopes: scopes.filter((scope) => scope !== "drive"),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    await deleteLegacyTwin(action.legacyId);
    return true;
  }

  await revokeToken(decryptApiKey(googleSnap!.data()!.encryptedRefreshToken));
  await ref.delete();
  await deleteLegacyTwin(action.legacyId);
  return true;
}

export interface DriveAccessTokenDependencies {
  refreshAccessToken: typeof refreshAccessToken;
  /** Refresh for tokens that live on a unified googleConnections doc. */
  refreshGoogleAccessToken: typeof refreshWorkspaceAccessToken;
}

const RECONNECT_MESSAGE = "This Google connection needs to be reconnected in Settings → Google.";

interface DriveTokenTarget {
  ref: FirebaseFirestore.DocumentReference;
  data: FirebaseFirestore.DocumentData;
  refresh: (refreshTokenValue: string) => Promise<{ accessToken: string; expiresIn: number }>;
}

async function loadTokenTarget(
  uid: string,
  connectionId: string,
  dependencies: Partial<DriveAccessTokenDependencies>,
): Promise<DriveTokenTarget> {
  const resolved = await resolveDriveConnectionId(uid, connectionId);
  if (!resolved) throw new DriveConnectionError("not_found", "This Google connection no longer exists. Reconnect it in Settings → Google.");

  if (resolved.kind === "legacy") {
    const ref = connectionsRef(uid).doc(resolved.id);
    const snap = await ref.get();
    if (!snap.exists) throw new DriveConnectionError("not_found", "This Google connection no longer exists. Reconnect it in Settings → Google.");
    return { ref, data: snap.data()!, refresh: dependencies.refreshAccessToken ?? refreshAccessToken };
  }

  const ref = googleConnectionsRef(uid).doc(resolved.id);
  const snap = await ref.get();
  if (!snap.exists) throw new DriveConnectionError("not_found", "This Google connection no longer exists. Reconnect it in Settings → Google.");
  const data = snap.data()!;
  if (!googleDocHasDrive(data)) {
    throw new DriveConnectionError("invalid", "Google Drive access is not turned on for this connection. Add it in Settings → Google.");
  }
  return { ref, data, refresh: dependencies.refreshGoogleAccessToken ?? refreshWorkspaceAccessToken };
}

/** Returns a cached access token when it has more than 60 seconds remaining.
 *  The cache is per server instance; revocation is observed at expiry unless
 *  an API request returns 401, in which case the entry is invalidated. */
export async function getAccessTokenForConnection(
  uid: string,
  connectionId: string,
  dependencies: Partial<DriveAccessTokenDependencies> = {},
): Promise<string> {
  const key = accessTokenCacheKey(uid, connectionId);
  return accessTokenCache.get(key, async () => {
    const { ref, data, refresh } = await loadTokenTarget(uid, connectionId, dependencies);
    if (data.status === "invalid") throw new DriveConnectionError("invalid", RECONNECT_MESSAGE);

    const refreshTokenValue = decryptApiKey(data.encryptedRefreshToken);
    try {
      const { accessToken, expiresIn } = await refresh(refreshTokenValue);
      const now = Date.now();
      const storedLastUsedAt = typeof data.lastUsedAt?.toMillis === "function" ? data.lastUsedAt.toMillis() : 0;
      const lastWrittenAt = Math.max(storedLastUsedAt, lastUsedWriteAt.get(key) ?? 0);
      if (now - lastWrittenAt >= LAST_USED_WRITE_INTERVAL_MS) {
        try {
          await ref.update({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp() });
          lastUsedWriteAt.set(key, now);
          if (lastUsedWriteAt.size > 1000) {
            const oldestKey = lastUsedWriteAt.keys().next().value;
            if (oldestKey) lastUsedWriteAt.delete(oldestKey);
          }
        } catch {
          // Usage metadata must not prevent playback when the token is valid.
        }
      }
      return { token: accessToken, expiresAt: now + Math.max(0, expiresIn) * 1000 };
    } catch (error: unknown) {
      if (isGoogleAuthInvalid(error)) {
        invalidateAccessToken(uid, connectionId);
        await ref.update({ status: "invalid" });
        throw new DriveConnectionError("invalid", RECONNECT_MESSAGE);
      }
      throw new DriveConnectionError("network", "Couldn't reach Google Drive. Try again in a moment.");
    }
  });
}

export class DriveConnectionError extends Error {
  code: "not_found" | "invalid" | "network";
  constructor(code: "not_found" | "invalid" | "network", message: string) {
    super(message);
    this.code = code;
  }
}
