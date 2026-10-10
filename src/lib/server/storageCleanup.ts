/**
 * Roadmap P6: storage health and cleanup. Pure rules + orchestration over injected deps (unit-tested with fakes).
 * Every action reports an exact count BEFORE anything is deleted (preview), deletes at most 400 documents per call,
 * and never touches Drive files.
 */
export const CLEANUP_ACTIONS = ["quiz_attempts", "learning_events", "thumbnails", "used_tokens", "sync_log"] as const;
export type CleanupAction = (typeof CLEANUP_ACTIONS)[number];

export const DELETE_BATCH_SIZE = 400;
export const THUMBNAIL_BATCH_SIZE = 50;
export const KEEP_NEWEST_ATTEMPTS = 200;
export const KEEP_SYNC_LOG = 200;
export const DEFAULT_ATTEMPT_MONTHS = 12;
export const MAX_MONTHS = 120;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

export interface CleanupParams { months: number }

export function isCleanupAction(value: unknown): value is CleanupAction {
  return typeof value === "string" && (CLEANUP_ACTIONS as readonly string[]).includes(value);
}

/** Validates a request body. Null = invalid. `months` only matters for quiz_attempts. */
export function parseCleanupRequest(body: Record<string, unknown>): { action: CleanupAction; params: CleanupParams } | null {
  if (!isCleanupAction(body.action)) return null;
  let months = DEFAULT_ATTEMPT_MONTHS;
  if (body.months !== undefined) {
    if (typeof body.months !== "number" || !Number.isInteger(body.months) || body.months < 1 || body.months > MAX_MONTHS) return null;
    months = body.months;
  }
  return { action: body.action, params: { months } };
}

/**
 * Quiz attempts to delete are those older than `months` AND outside the newest `keep`. Returns the timestamp (ms):
 * delete everything strictly OLDER than it. null = nothing is deletable (fewer than `keep` attempts).
 * `newestTimesDesc` = completion times of the newest `keep` attempts, newest first.
 */
export function attemptCutoffMs(input: { nowMs: number; months: number; newestTimesDesc: readonly number[]; keep?: number }): number | null {
  const keep = input.keep ?? KEEP_NEWEST_ATTEMPTS;
  if (input.newestTimesDesc.length < keep) return null;
  const oldestKept = input.newestTimesDesc[keep - 1];
  return Math.min(input.nowMs - input.months * MONTH_MS, oldestKept);
}

/** Cutoff for "keep the newest N": delete strictly older than the Nth newest. null when there are not more than N. */
export function keepNewestCutoffMs(newestTimesDesc: readonly number[], keep: number): number | null {
  return newestTimesDesc.length < keep ? null : newestTimesDesc[keep - 1];
}

export function chunk<T>(items: readonly T[], size = DELETE_BATCH_SIZE): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export interface CleanupDeps {
  /** Exact number of items this action would delete right now. */
  count(action: CleanupAction, params: CleanupParams): Promise<number>;
  /** Deletes up to `limit` items; returns how many were deleted. */
  remove(action: CleanupAction, params: CleanupParams, limit: number): Promise<number>;
}

export const batchSizeFor = (action: CleanupAction) => (action === "thumbnails" ? THUMBNAIL_BATCH_SIZE : DELETE_BATCH_SIZE);

export async function previewCleanup(deps: CleanupDeps, action: CleanupAction, params: CleanupParams): Promise<{ count: number }> {
  return { count: await deps.count(action, params) };
}

export async function runCleanup(deps: CleanupDeps, action: CleanupAction, params: CleanupParams): Promise<{ deleted: number; remaining: number }> {
  const before = await deps.count(action, params);
  if (before === 0) return { deleted: 0, remaining: 0 };
  const deleted = Math.min(before, await deps.remove(action, params, batchSizeFor(action)));
  return { deleted, remaining: Math.max(0, before - deleted) };
}

/** Collections shown on the health page, in display order. `label` is plain language for the user. */
export const HEALTH_COLLECTIONS = [
  { id: "personalDocuments", label: "Study materials" },
  { id: "goals", label: "Goals" },
  { id: "notes", label: "Notes" },
  { id: "summaries", label: "Summaries" },
  { id: "transcripts", label: "Transcripts" },
  { id: "quizAttempts", label: "Quiz attempts" },
  { id: "learningDays", label: "Daily activity" },
  { id: "learningEvents", label: "Old activity events" },
  { id: "driveThumbs", label: "Drive thumbnails" },
  { id: "blobs", label: "Files kept in Google Drive" },
  { id: "googleSyncLog", label: "Google sync history" },
  { id: "googleUsedTokens", label: "Used sync confirmations" },
] as const;

export const FREE_PLAN_NOTE = "The free plan allows about 20,000 deletes per day. For very large cleanups, run a few batches today and the rest tomorrow.";
