import { doc, increment, serverTimestamp, setDoc } from "@/lib/firestore/instrumented";
import { db } from "@/lib/firebase";
import { localIsoDate } from "@/lib/isoDate";
import { createLearningQueue, type LearningDayField, type PendingLearningDay } from "@/lib/learningDays";

export type LearningEventName =
  | "onboarding_completed"
  | "onboarding_skipped"
  | "video_completed"
  | "goal_completed"
  | "goal_behind_pace"
  | "tour_started"
  | "tour_completed"
  | "tour_skipped";

/**
 * P3: events are queued in memory and written at most once a minute as ONE aggregate document per local day,
 * users/{uid}/learningDays/{yyyy-MM-dd} (increment() fields), instead of one document per event.
 * The per-event `metadata` is intentionally not stored any more.
 */
const FLUSH_INTERVAL_MS = 60_000;
const queues = new Map<string, ReturnType<typeof createLearningQueue>>();
let timer: ReturnType<typeof setTimeout> | null = null;
let listenersInstalled = false;

function queueFor(uid: string) {
  let queue = queues.get(uid);
  if (!queue) { queue = createLearningQueue(); queues.set(uid, queue); }
  return queue;
}

function schedule(): void {
  installListeners();
  if (timer) return;
  timer = setTimeout(() => { timer = null; void flushLearningDays(); }, FLUSH_INTERVAL_MS);
}

function installListeners(): void {
  if (listenersInstalled || typeof window === "undefined") return;
  listenersInstalled = true;
  window.addEventListener("pagehide", () => { void flushLearningDays(); });
  window.document.addEventListener("visibilitychange", () => {
    if (window.document.visibilityState === "hidden") void flushLearningDays();
  });
}

export async function trackLearningEvent(
  uid: string,
  eventName: LearningEventName,
  _metadata: Record<string, string | number | boolean | null> = {},
): Promise<void> {
  queueFor(uid).addEvent(localIsoDate(), eventName);
  schedule();
}

/** Adds study time/quiz counts to today's aggregate (watchSeconds, docMinutes, quizzes). */
export function recordLearningAmount(uid: string, field: Exclude<LearningDayField, "events">, amount: number): void {
  queueFor(uid).addAmount(localIsoDate(), field, amount);
  schedule();
}

function dayPayload(item: PendingLearningDay): Record<string, unknown> {
  const payload: Record<string, unknown> = { updatedAt: serverTimestamp() };
  for (const [field, amount] of Object.entries(item.counts)) payload[field] = increment(amount ?? 0);
  if (Object.keys(item.byEvent).length > 0) {
    payload.byEvent = Object.fromEntries(Object.entries(item.byEvent).map(([name, amount]) => [name, increment(amount)]));
  }
  return payload;
}

/** Writes every queued day (one write per user-day). A failed write is put back in the queue for the next flush. */
export async function flushLearningDays(): Promise<void> {
  if (timer) { clearTimeout(timer); timer = null; }
  for (const [uid, queue] of queues) {
    const days = queue.drain();
    for (let index = 0; index < days.length; index++) {
      try {
        await setDoc(doc(db, "users", uid, "learningDays", days[index].day), dayPayload(days[index]), { merge: true });
      } catch {
        // Telemetry must never block the learning action; keep the unsent days for the next flush.
        queue.restore(days.slice(index));
        schedule();
        break;
      }
    }
  }
}
