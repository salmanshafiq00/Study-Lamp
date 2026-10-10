// G7: removes old driveConnections docs, but ONLY those whose unified googleConnections twin exists and points back
// to them (legacyDriveConnectionId). Pure core; I/O injected. Deleting the old doc never revokes a token: the grant
// is shared with the unified connection.

type Data = Record<string, unknown>;
export interface CleanupRow { id: string; data: Data }

export interface CleanupStore {
  listLegacy(uid: string): Promise<CleanupRow[]>;
  listGoogle(uid: string): Promise<CleanupRow[]>;
  deleteLegacy(uid: string, id: string): Promise<void>;
}

export interface CleanupPlan {
  /** Old doc ids that are safe to delete. */
  deletable: string[];
  /** Old docs that are NOT safe yet (not migrated, or the twin does not link back). Kept untouched. */
  blocked: number;
}

export function planLegacyCleanup(legacy: ReadonlyArray<CleanupRow>, google: ReadonlyArray<CleanupRow>): CleanupPlan {
  const linked = new Set(
    google.map((doc) => doc.data.legacyDriveConnectionId).filter((value): value is string => typeof value === "string" && value.length > 0),
  );
  const googleById = new Map(google.map((doc) => [doc.id, doc]));
  const deletable: string[] = [];
  for (const old of legacy) {
    const target = typeof old.data.migratedTo === "string" ? googleById.get(old.data.migratedTo) : undefined;
    const twinLinksBack = Boolean(target) && target!.data.legacyDriveConnectionId === old.id;
    if (twinLinksBack && linked.has(old.id)) deletable.push(old.id);
  }
  return { deletable, blocked: legacy.length - deletable.length };
}

export async function cleanupLegacyDriveConnections(store: CleanupStore, uid: string): Promise<{ deleted: number; blocked: number }> {
  const plan = planLegacyCleanup(await store.listLegacy(uid), await store.listGoogle(uid));
  for (const id of plan.deletable) await store.deleteLegacy(uid, id);
  return { deleted: plan.deletable.length, blocked: plan.blocked };
}
