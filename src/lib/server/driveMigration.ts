// Step G5: moves old Drive connections (users/{uid}/driveConnections) onto the unified connection
// (users/{uid}/googleConnections with "drive" in grantedScopes). Pure core: all I/O is injected so the safety rules
// below are unit-tested with recording fakes.
//
// Safety rules:
//  - Nothing is ever deleted here. The old doc only gets `migratedTo` AFTER the unified doc is ready and verified.
//  - Verification = the token refreshes with the unified client, and (when a Study Lamp data folder is known) Drive
//    can read that folder. If either fails, NOTHING is written for that account.
//  - Refresh tokens are never merged or overwritten: a unified doc that already has its own token keeps it. When it
//    lacks Drive the account is reported as "needs_drive_consent" (one consent for Drive only fixes it).
//  - Idempotent: a second run changes nothing.

export type MigrationOutcome =
  | "migrated"             // old doc linked (and a unified doc created when there was none)
  | "already_migrated"     // nothing to do
  | "needs_drive_consent"  // a unified doc exists for this account but has no Drive grant: add Drive access, then run again
  | "skipped_invalid"      // the old connection needs reconnecting first
  | "verify_failed";       // the token or the folder could not be verified; nothing was written

export interface MigrationItem {
  legacyId: string;
  outcome: MigrationOutcome;
}

export interface MigrationReport {
  items: MigrationItem[];
  counts: Record<MigrationOutcome, number>;
}

type Data = Record<string, unknown>;
export interface DocRow { id: string; data: Data }

export interface MigrationStore {
  listLegacy(uid: string): Promise<DocRow[]>;
  listGoogle(uid: string): Promise<DocRow[]>;
  /** Creates a unified doc and returns its id. */
  createGoogle(uid: string, data: Data): Promise<string>;
  updateGoogle(uid: string, id: string, patch: Data): Promise<void>;
  updateLegacy(uid: string, id: string, patch: Data): Promise<void>;
}

export interface MigrationDeps {
  store: MigrationStore;
  /** True when `encryptedRefreshToken` refreshes AND (when given) the Drive folder can be read with it. Never throws. */
  verify(uid: string, encryptedRefreshToken: string, appFolderId: string | null): Promise<boolean>;
  /** Server timestamp placeholder, injected so tests need no Firebase. */
  now(): unknown;
}

function emailKey(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function scopesOf(data: Data): string[] {
  return Array.isArray(data.grantedScopes) ? (data.grantedScopes as unknown[]).filter((v): v is string => typeof v === "string") : [];
}

export function emptyCounts(): Record<MigrationOutcome, number> {
  return { migrated: 0, already_migrated: 0, needs_drive_consent: 0, skipped_invalid: 0, verify_failed: 0 };
}

/** Legacy connections that still need work (no `migratedTo`). Used for the count shown in the confirm dialog. */
export function pendingLegacyCount(legacy: ReadonlyArray<DocRow>, google: ReadonlyArray<DocRow>): number {
  const googleIds = new Set(google.map((doc) => doc.id));
  return legacy.filter((doc) => {
    const target = stringOrNull(doc.data.migratedTo);
    return !(target && googleIds.has(target));
  }).length;
}

export async function migrateDriveConnections(deps: MigrationDeps, uid: string): Promise<MigrationReport> {
  const { store } = deps;
  const legacy = await store.listLegacy(uid);
  const google = await store.listGoogle(uid);
  const items: MigrationItem[] = [];

  for (const old of legacy) {
    const outcome = await migrateOne(deps, uid, old, google);
    items.push({ legacyId: old.id, outcome });
  }

  const counts = emptyCounts();
  for (const item of items) counts[item.outcome] += 1;
  return { items, counts };
}

async function migrateOne(deps: MigrationDeps, uid: string, old: DocRow, google: DocRow[]): Promise<MigrationOutcome> {
  const { store } = deps;
  const googleIds = new Set(google.map((doc) => doc.id));
  const migratedTo = stringOrNull(old.data.migratedTo);
  if (migratedTo && googleIds.has(migratedTo)) return "already_migrated";

  const email = emailKey(old.data.googleEmail);
  const encrypted = stringOrNull(old.data.encryptedRefreshToken);
  if (!email || !encrypted) return "verify_failed";

  const twin = google.find((doc) => emailKey(doc.data.googleEmail) === email);

  // A) Crash recovery: the unified doc was linked in an earlier run but the old doc was not marked yet.
  if (twin && stringOrNull(twin.data.legacyDriveConnectionId) === old.id && scopesOf(twin.data).includes("drive")) {
    await store.updateLegacy(uid, old.id, { migratedTo: twin.id, migratedAt: deps.now() });
    return "migrated";
  }

  // B) A unified doc for this account exists.
  if (twin) {
    if (!scopesOf(twin.data).includes("drive")) return "needs_drive_consent";
    if (twin.data.status === "invalid") return "skipped_invalid";
    const twinToken = stringOrNull(twin.data.encryptedRefreshToken);
    const folderId = stringOrNull(old.data.appFolderId) ?? stringOrNull(twin.data.appFolderId);
    if (!twinToken || !(await deps.verify(uid, twinToken, folderId))) return "verify_failed";
    // Link only; the unified doc keeps its own token.
    const patch: Data = { legacyDriveConnectionId: old.id, updatedAt: deps.now() };
    if (folderId) patch.appFolderId = folderId;
    await store.updateGoogle(uid, twin.id, patch);
    await store.updateLegacy(uid, old.id, { migratedTo: twin.id, migratedAt: deps.now() });
    return "migrated";
  }

  // C) No unified doc for this account: create one from the old token (verified first).
  if (old.data.status === "invalid") return "skipped_invalid";
  const folderId = stringOrNull(old.data.appFolderId);
  if (!(await deps.verify(uid, encrypted, folderId))) return "verify_failed";
  const doc: Data = {
    googleEmail: old.data.googleEmail,
    encryptedRefreshToken: encrypted,
    grantedScopes: ["drive"],
    status: "active",
    calendar: { enabled: false },
    tasks: { enabled: false },
    legacyDriveConnectionId: old.id,
    createdAt: old.data.createdAt ?? deps.now(),
    updatedAt: deps.now(),
    lastUsedAt: old.data.lastUsedAt ?? null,
  };
  if (folderId) doc.appFolderId = folderId;
  const newId = await store.createGoogle(uid, doc);
  await store.updateLegacy(uid, old.id, { migratedTo: newId, migratedAt: deps.now() });
  // Keep the in-memory view consistent for the rest of this run (two old docs never share an email, but be safe).
  google.push({ id: newId, data: doc });
  return "migrated";
}
