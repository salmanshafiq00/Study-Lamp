/** Pure Firestore usage counter (no Firebase import) so it can be unit-tested. Used only by the dev probe. */
export interface UsageRow { reads: number; writes: number; deletes: number }
export type UsageKind = keyof UsageRow;

/** "users/abc/personalDocuments/x" -> "users/{id}/personalDocuments" (collection shape, no ids). */
export function collectionShape(path: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length === 0) return "unknown";
  // Odd segment count = collection path, even = document path; keep collection segments only.
  const collections = segments.filter((_, index) => index % 2 === 0);
  const first = collections[0];
  return segments.length > 1 && collections.length > 1 ? `${first}/…/${collections[collections.length - 1]}` : first;
}

/** getDoc = 1 read; getDocs = max(1, size) reads (Firestore bills a query for at least one read). */
export function readsForSnapshotSize(size: number): number {
  return Math.max(1, size);
}

export function createUsageCounter() {
  const rows = new Map<string, UsageRow>();
  return {
    record(kind: UsageKind, path: string, count = 1): void {
      const key = collectionShape(path);
      const row = rows.get(key) ?? { reads: 0, writes: 0, deletes: 0 };
      row[kind] += count;
      rows.set(key, row);
    },
    snapshot(): Record<string, UsageRow> {
      return Object.fromEntries([...rows.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
    totals(): UsageRow {
      const total: UsageRow = { reads: 0, writes: 0, deletes: 0 };
      for (const row of rows.values()) { total.reads += row.reads; total.writes += row.writes; total.deletes += row.deletes; }
      return total;
    },
    reset(): void { rows.clear(); },
  };
}
