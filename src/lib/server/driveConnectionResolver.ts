// Step G5: maps a Drive connection id to the document that actually holds the token.
// Pure: the Firestore access is injected (ResolverStore), so this is unit-tested with in-memory fakes.
//
// Two kinds of ids exist after the merge:
//   - a legacy id  -> users/{uid}/driveConnections/{id}   (what already-imported documents store in `driveConnectionId`)
//   - a google id  -> users/{uid}/googleConnections/{id}  (the unified connection; `grantedScopes` contains "drive")
// A migrated legacy doc carries `migratedTo` (the google id) and the google doc carries `legacyDriveConnectionId`,
// so documents that store the legacy id keep opening WITHOUT rewriting any document.

export interface DocSnapLike {
  id: string;
  exists: boolean;
  data(): Record<string, unknown> | undefined;
}

export interface ResolverStore {
  getGoogle(uid: string, id: string): Promise<DocSnapLike>;
  getLegacy(uid: string, id: string): Promise<DocSnapLike>;
  /** googleConnections doc whose legacyDriveConnectionId equals `legacyId`, or null. */
  findGoogleByLegacyId(uid: string, legacyId: string): Promise<DocSnapLike | null>;
}

export type ResolvedDriveConnection =
  | { kind: "google"; id: string; legacyId: string | null; hasDrive: boolean }
  | { kind: "legacy"; id: string };

export function isPlausibleDocId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("/");
}

/** True when the unified connection's `grantedScopes` includes "drive". */
export function googleDocHasDrive(data: Record<string, unknown> | undefined): boolean {
  return Array.isArray(data?.grantedScopes) && (data!.grantedScopes as unknown[]).includes("drive");
}

/** A unified connection that has Drive but neither Calendar nor Tasks. The Calendar/Tasks cards hide it. */
export function isDriveOnlyConnection(data: Record<string, unknown> | undefined): boolean {
  const scopes = Array.isArray(data?.grantedScopes) ? (data!.grantedScopes as unknown[]) : [];
  return scopes.includes("drive") && !scopes.includes("calendar") && !scopes.includes("tasks");
}

function legacyIdOf(data: Record<string, unknown> | undefined): string | null {
  const value = data?.legacyDriveConnectionId;
  return typeof value === "string" && value ? value : null;
}

/** Resolves an id (legacy or google) to the document that holds the token. Null when nothing matches. */
export async function resolveDriveConnection(store: ResolverStore, uid: string, id: string): Promise<ResolvedDriveConnection | null> {
  if (!isPlausibleDocId(id)) return null;

  // 1. A unified connection id.
  const google = await store.getGoogle(uid, id);
  if (google.exists) {
    return { kind: "google", id: google.id, legacyId: legacyIdOf(google.data()), hasDrive: googleDocHasDrive(google.data()) };
  }

  // 2. A legacy id.
  const legacy = await store.getLegacy(uid, id);
  if (legacy.exists) {
    const migratedTo = legacy.data()?.migratedTo;
    if (isPlausibleDocId(migratedTo)) {
      const target = await store.getGoogle(uid, migratedTo);
      // Target exists: use it, even when Drive was switched off there (the caller reports "reconnect"); falling back
      // to the old token would silently bring back access the user turned off.
      if (target.exists) return { kind: "google", id: target.id, legacyId: id, hasDrive: googleDocHasDrive(target.data()) };
    }
    return { kind: "legacy", id };
  }

  // 3. The legacy doc was cleaned up (G7) but documents still store its id: find the unified doc by link.
  const linked = await store.findGoogleByLegacyId(uid, id);
  if (linked?.exists) return { kind: "google", id: linked.id, legacyId: id, hasDrive: googleDocHasDrive(linked.data()) };
  return null;
}

export interface ListedDriveDoc {
  /** The id other documents use for this connection: the legacy id when one exists, otherwise the google id. */
  id: string;
  source: "legacy" | "google";
  data: Record<string, unknown>;
}

/**
 * The Drive listing: legacy docs not yet migrated + unified docs that have Drive on. A migrated pair appears once,
 * under the id existing documents already store. Pure.
 */
export function selectDriveListing(
  legacyDocs: ReadonlyArray<{ id: string; data: Record<string, unknown> }>,
  googleDocs: ReadonlyArray<{ id: string; data: Record<string, unknown> }>,
): ListedDriveDoc[] {
  const googleIds = new Set(googleDocs.map((doc) => doc.id));
  const linkedLegacyIds = new Set(googleDocs.map((doc) => legacyIdOf(doc.data)).filter((value): value is string => Boolean(value)));

  const result: ListedDriveDoc[] = [];
  for (const legacy of legacyDocs) {
    const migratedTo = legacy.data.migratedTo;
    const migrated = typeof migratedTo === "string" && googleIds.has(migratedTo);
    if (migrated || linkedLegacyIds.has(legacy.id)) continue; // listed through its unified doc (or hidden when Drive is off there)
    result.push({ id: legacy.id, source: "legacy", data: legacy.data });
  }
  for (const google of googleDocs) {
    if (!googleDocHasDrive(google.data)) continue;
    result.push({ id: legacyIdOf(google.data) ?? google.id, source: "google", data: google.data });
  }
  return result;
}

export type DriveDisconnectAction =
  | { kind: "delete_legacy"; legacyId: string }
  | { kind: "delete_google"; googleId: string; legacyId: string | null }
  | { kind: "drop_drive_feature"; googleId: string; legacyId: string | null };

/**
 * What "Disconnect" means for a Drive connection.
 *  - legacy doc                          -> delete it (and revoke its token)
 *  - unified doc used only for Drive     -> delete it (and revoke)
 *  - unified doc that also has Calendar/Tasks -> only switch Drive off; the token stays for the other features
 */
export function planDriveDisconnect(resolved: ResolvedDriveConnection, googleData?: Record<string, unknown>): DriveDisconnectAction {
  if (resolved.kind === "legacy") return { kind: "delete_legacy", legacyId: resolved.id };
  const scopes = Array.isArray(googleData?.grantedScopes) ? (googleData!.grantedScopes as unknown[]) : [];
  const usedElsewhere = scopes.includes("calendar") || scopes.includes("tasks");
  return usedElsewhere
    ? { kind: "drop_drive_feature", googleId: resolved.id, legacyId: resolved.legacyId }
    : { kind: "delete_google", googleId: resolved.id, legacyId: resolved.legacyId };
}
