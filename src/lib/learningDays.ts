/**
 * Aggregated learning activity (roadmap P3): one document per local day, users/{uid}/learningDays/{yyyy-MM-dd},
 * instead of one document per event. Pure: no Firebase import (the Firestore write lives in analytics.ts).
 */
export const LEARNING_DAY_NUMERIC_FIELDS = ["watchSeconds", "docMinutes", "quizzes", "events"] as const;
export type LearningDayField = (typeof LEARNING_DAY_NUMERIC_FIELDS)[number];

export interface PendingLearningDay {
  /** Local date (yyyy-MM-dd) the activity happened on. */
  day: string;
  counts: Partial<Record<LearningDayField, number>>;
  byEvent: Record<string, number>;
}

const EVENT_NAME = /^[a-z0-9_]{1,40}$/;

/** Accumulates activity in memory; drain() hands back everything and empties the queue. */
export function createLearningQueue() {
  const days = new Map<string, PendingLearningDay>();
  const entry = (day: string): PendingLearningDay => {
    let value = days.get(day);
    if (!value) { value = { day, counts: {}, byEvent: {} }; days.set(day, value); }
    return value;
  };
  return {
    addEvent(day: string, eventName: string): void {
      if (!EVENT_NAME.test(eventName)) return;
      const value = entry(day);
      value.counts.events = (value.counts.events ?? 0) + 1;
      value.byEvent[eventName] = (value.byEvent[eventName] ?? 0) + 1;
    },
    addAmount(day: string, field: LearningDayField, amount: number): void {
      if (!Number.isFinite(amount) || amount <= 0) return;
      const value = entry(day);
      value.counts[field] = (value.counts[field] ?? 0) + Math.round(amount);
    },
    size: () => days.size,
    drain(): PendingLearningDay[] {
      const result = [...days.values()];
      days.clear();
      return result;
    },
    /** Puts drained days back after a failed write so nothing is lost. */
    restore(items: PendingLearningDay[]): void {
      for (const item of items) {
        const target = entry(item.day);
        for (const [field, amount] of Object.entries(item.counts)) {
          const key = field as LearningDayField;
          target.counts[key] = (target.counts[key] ?? 0) + (amount ?? 0);
        }
        for (const [name, amount] of Object.entries(item.byEvent)) target.byEvent[name] = (target.byEvent[name] ?? 0) + amount;
      }
    },
  };
}

/** The first day (yyyy-MM-dd, local) on which learningDays replaces learningEvents; older days keep reading the old data. */
export const LEARNING_DAYS_CUTOVER = "2026-10-10";
