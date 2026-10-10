import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { pruneUsedTokens } from "@/lib/server/googleUsedTokens";
import { pruneUnreferencedThumbnails } from "@/lib/server/driveThumbnailPrune";
import {
  HEALTH_COLLECTIONS, KEEP_NEWEST_ATTEMPTS, KEEP_SYNC_LOG, attemptCutoffMs, keepNewestCutoffMs,
  type CleanupAction, type CleanupDeps, type CleanupParams,
} from "@/lib/server/storageCleanup";

const col = (uid: string, name: string) => adminDb.collection("users").doc(uid).collection(name);
const millis = (value: unknown): number | null => (value instanceof admin.firestore.Timestamp ? value.toMillis() : null);

/** Newest `keep` timestamps of `field` (newest first). Reads `keep` index entries; documents are not downloaded in full. */
async function newestTimes(uid: string, name: string, field: string, keep: number): Promise<number[]> {
  const snap = await col(uid, name).orderBy(field, "desc").select(field).limit(keep).get();
  return snap.docs.map((d) => millis(d.get(field))).filter((t): t is number => t !== null);
}

async function cutoffQuery(uid: string, action: "quiz_attempts" | "sync_log", params: CleanupParams, nowMs: number) {
  if (action === "quiz_attempts") {
    const cutoff = attemptCutoffMs({ nowMs, months: params.months, newestTimesDesc: await newestTimes(uid, "quizAttempts", "completedAt", KEEP_NEWEST_ATTEMPTS) });
    return cutoff === null ? null : col(uid, "quizAttempts").where("completedAt", "<", admin.firestore.Timestamp.fromMillis(cutoff));
  }
  const cutoff = keepNewestCutoffMs(await newestTimes(uid, "googleSyncLog", "_at", KEEP_SYNC_LOG), KEEP_SYNC_LOG);
  return cutoff === null ? null : col(uid, "googleSyncLog").where("_at", "<", admin.firestore.Timestamp.fromMillis(cutoff));
}

export function createAdminCleanupDeps(uid: string, nowMs: () => number = Date.now): CleanupDeps {
  return {
    async count(action, params) {
      switch (action) {
        case "quiz_attempts":
        case "sync_log": {
          const query = await cutoffQuery(uid, action, params, nowMs());
          return query ? (await query.count().get()).data().count : 0;
        }
        case "learning_events": return (await col(uid, "learningEvents").count().get()).data().count;
        case "used_tokens": return (await col(uid, "googleUsedTokens").where("exp", "<=", Math.floor(nowMs() / 1000)).count().get()).data().count;
        case "thumbnails": return (await pruneUnreferencedThumbnails(uid, 0)).remaining; // limit 0 = scan only, deletes nothing
      }
    },
    async remove(action: CleanupAction, params, limit) {
      switch (action) {
        case "quiz_attempts":
        case "sync_log": {
          const query = await cutoffQuery(uid, action, params, nowMs());
          if (!query) return 0;
          const snap = await query.select().limit(limit).get();
          const batch = adminDb.batch();
          snap.docs.forEach((d) => batch.delete(d.ref));
          if (!snap.empty) await batch.commit();
          return snap.size;
        }
        case "learning_events": {
          const snap = await col(uid, "learningEvents").select().limit(limit).get();
          const batch = adminDb.batch();
          snap.docs.forEach((d) => batch.delete(d.ref));
          if (!snap.empty) await batch.commit();
          return snap.size;
        }
        case "used_tokens": return pruneUsedTokens(uid, nowMs(), limit);
        case "thumbnails": return (await pruneUnreferencedThumbnails(uid, limit)).pruned;
      }
    },
  };
}

/** One count aggregation per collection (about 1 read per 1,000 documents; never loads the documents). */
export async function loadStorageCounts(uid: string): Promise<Array<{ id: string; label: string; count: number }>> {
  return Promise.all(HEALTH_COLLECTIONS.map(async ({ id, label }) => ({ id, label, count: (await col(uid, id).count().get()).data().count })));
}
