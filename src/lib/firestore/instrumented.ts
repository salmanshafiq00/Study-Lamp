/**
 * Drop-in replacement for "firebase/firestore" used by src/lib/firestore/*.ts and analytics.ts (roadmap P1).
 * In production every wrapped function is the plain Firebase function (zero overhead; the counting branch is dead
 * code that the bundler removes). In development it counts reads/writes/deletes per collection:
 *   window.__fsUsage()       -> console.table of reads/writes/deletes per collection shape
 *   window.__fsUsageReset()  -> clears the counters
 * Not counted: runTransaction, getCountFromServer (1 read per 1000 index entries), pages that import Firebase directly.
 */
import * as fs from "firebase/firestore";
import { createUsageCounter, readsForSnapshotSize, type UsageKind } from "@/lib/usageCounter";

export * from "firebase/firestore";

const ENABLED = process.env.NODE_ENV !== "production";
const counter = createUsageCounter();

declare global {
  interface Window {
    __fsUsage?: () => Record<string, { reads: number; writes: number; deletes: number }>;
    __fsUsageReset?: () => void;
  }
}

if (ENABLED && typeof window !== "undefined") {
  window.__fsUsage = () => {
    const snapshot = counter.snapshot();
    console.table(snapshot);
    console.log("total", counter.totals());
    return snapshot;
  };
  window.__fsUsageReset = () => counter.reset();
}

/** Path of a document/collection reference or of a query ("" when it cannot be read). */
function pathOf(target: unknown): string {
  try {
    const direct = (target as { path?: unknown }).path;
    if (typeof direct === "string") return direct;
    const query = target as { _query?: { path?: { canonicalString?: () => string } } };
    return query._query?.path?.canonicalString?.() ?? "";
  } catch {
    return "";
  }
}

function track<F extends (...args: never[]) => Promise<unknown>>(
  fn: F,
  record: (args: Parameters<F>, result: Awaited<ReturnType<F>>) => void,
): F {
  if (!ENABLED) return fn;
  return (async (...args: Parameters<F>) => {
    const result = await fn(...args);
    try { record(args, result as Awaited<ReturnType<F>>); } catch { /* counting must never break a call */ }
    return result;
  }) as unknown as F;
}

const note = (kind: UsageKind, target: unknown, count = 1) => counter.record(kind, pathOf(target), count);

export const getDoc = track(fs.getDoc, ([ref]) => note("reads", ref));
export const getDocs = track(fs.getDocs, ([query], snapshot) => note("reads", query, readsForSnapshotSize(snapshot.size)));
export const setDoc = track(fs.setDoc as (...args: never[]) => Promise<void>, ([ref]) => note("writes", ref)) as typeof fs.setDoc;
export const updateDoc = track(fs.updateDoc as (...args: never[]) => Promise<void>, ([ref]) => note("writes", ref)) as typeof fs.updateDoc;
export const addDoc = track(fs.addDoc, ([ref]) => note("writes", ref));
export const deleteDoc = track(fs.deleteDoc, ([ref]) => note("deletes", ref));

export const writeBatch: typeof fs.writeBatch = ENABLED
  ? (firestore) => {
      const batch = fs.writeBatch(firestore);
      const pending: Array<{ kind: UsageKind; target: unknown }> = [];
      const originalSet = batch.set.bind(batch) as (...args: unknown[]) => unknown;
      const originalUpdate = batch.update.bind(batch) as (...args: unknown[]) => unknown;
      const originalDelete = batch.delete.bind(batch);
      const originalCommit = batch.commit.bind(batch);
      batch.set = ((ref: unknown, ...rest: unknown[]) => { pending.push({ kind: "writes", target: ref }); return originalSet(ref, ...rest); }) as typeof batch.set;
      batch.update = ((ref: unknown, ...rest: unknown[]) => { pending.push({ kind: "writes", target: ref }); return originalUpdate(ref, ...rest); }) as typeof batch.update;
      batch.delete = ((ref) => { pending.push({ kind: "deletes", target: ref }); return originalDelete(ref); }) as typeof batch.delete;
      batch.commit = async () => {
        await originalCommit();
        for (const entry of pending) note(entry.kind, entry.target);
        pending.length = 0;
      };
      return batch;
    }
  : fs.writeBatch;
