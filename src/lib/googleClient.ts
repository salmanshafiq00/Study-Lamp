import type { PlanItem, SyncResolution } from "@/lib/sync/plan";
import type { RemovalApplyResult, RemovalPreviewResult, RemovalScope, RemovalTarget } from "@/lib/googleRemovalFlow";
import type { GoogleConnectionSummary, GoogleSyncHistoryEntry, GoogleSyncStatus, GoogleTasksStatus, GoogleWorkspaceFeature, GoogleFeature } from "@/types";

/** An API failure that keeps the HTTP status and the server's machine-readable `code` (for example "ambiguous"). */
export class GoogleApiError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = "GoogleApiError";
    this.status = status;
    this.code = code;
  }
}

/** True when the server said the user has several Google connections with this sync on and must keep only one (audit M2). */
export function isAmbiguousConnectionError(error: unknown): boolean {
  return error instanceof GoogleApiError && error.code === "ambiguous";
}

async function parseOrThrow(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new GoogleApiError(data.error || `Request failed (${res.status})`, res.status, typeof data.code === "string" ? data.code : null);
  return data;
}

function authHeaders(idToken: string, withJson = false): HeadersInit {
  return {
    Authorization: `Bearer ${idToken}`,
    ...(withJson ? { "Content-Type": "application/json" } : {}),
  };
}

/** W2: the connected Google Workspace accounts (safe summaries only). */
export async function listGoogleConnections(idToken: string): Promise<GoogleConnectionSummary[]> {
  const res = await fetch("/api/google/connections", { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return data.connections;
}

/** W2: starts the OAuth flow for the requested features and navigates the
 *  whole page to the server-built Google auth URL. */
export async function startGoogleConnect(idToken: string, features: GoogleFeature[]): Promise<void> {
  const res = await fetch("/api/google/auth/state", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ features }),
  });
  const data = await parseOrThrow(res);
  if (typeof data.url !== "string" || !data.url.startsWith("https://accounts.google.com/")) {
    throw new Error("Google returned an invalid authorization URL.");
  }
  window.location.assign(data.url);
}

/** W2: disconnects a Workspace account. The stored token is deleted and
 *  revoked at Google; nothing in Calendar or Tasks is deleted. */
export async function disconnectGoogleConnection(idToken: string, connectionId: string): Promise<void> {
  const res = await fetch(`/api/google/connections/${encodeURIComponent(connectionId)}`, {
    method: "DELETE",
    headers: authHeaders(idToken),
  });
  await parseOrThrow(res);
}

export async function getGoogleSyncStatus(idToken: string, connectionId?: string): Promise<GoogleSyncStatus> {
  const query = connectionId ? `?connectionId=${encodeURIComponent(connectionId)}` : "";
  const res = await fetch(`/api/google/sync/status${query}`, { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return data as GoogleSyncStatus;
}

/** `connectionId` is the real id of the Google connection (from listGoogleConnections). */
export async function toggleGoogleCalendar(idToken: string, connectionId: string, enabled: boolean): Promise<{ ok: true; connection: { id: string; enabled: boolean } }> {
  const res = await fetch(`/api/google/connections/${encodeURIComponent(connectionId)}`, {
    method: "PATCH",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ calendar: { enabled } }),
  });
  const data = await parseOrThrow(res);
  return data;
}

export interface GoogleSyncPlanResponse {
  planToken: string;
  items: PlanItem[];
  counts: { push: number; pull: number; conflict: number; attention: number; remoteDeleted: number; orphaned: number };
  orphans: Array<{ goalId: string; titleSnapshot: string; eventId: string }>;
  remaining: number;
}

/** Read-only. Nothing is written anywhere; the response only describes what an apply WOULD do. */
export async function planGoogleSync(idToken: string, goalIds?: string[], connectionId?: string): Promise<GoogleSyncPlanResponse> {
  const res = await fetch("/api/google/sync/plan", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ ...(goalIds && goalIds.length ? { goalIds } : {}), ...(connectionId ? { connectionId } : {}) }),
  });
  const data = await parseOrThrow(res);
  return data as GoogleSyncPlanResponse;
}

/** One target's plan inside a plan response (Tasks). Same shape as the Calendar plan, with task ids. */
export interface GoogleTasksPlanResponse {
  planToken: string;
  items: PlanItem[];
  counts: GoogleSyncPlanResponse["counts"];
  orphans: Array<{ goalId: string; titleSnapshot: string; taskId: string | null }>;
  remaining: number;
}

/** W4. Read-only. Asks only for the Tasks plan. Returns null when Tasks sync is off. */
export async function planGoogleTasksSync(idToken: string, goalIds?: string[], connectionId?: string): Promise<GoogleTasksPlanResponse | null> {
  const res = await fetch("/api/google/sync/plan", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ targets: ["tasks"], ...(goalIds && goalIds.length ? { goalIds } : {}), ...(connectionId ? { connectionId } : {}) }),
  });
  const data = await parseOrThrow(res);
  return (data.tasks as GoogleTasksPlanResponse | undefined) ?? null;
}

/** W4. Carries the TASKS plan token the user just confirmed. */
export async function applyGoogleTasksSync(
  idToken: string,
  input: { planToken: string; accepted: string[]; resolutions?: Record<string, SyncResolution>; confirmedDestructive?: string[]; connectionId?: string },
): Promise<GoogleSyncApplyResponse> {
  const res = await fetch("/api/google/sync/apply", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ ...input, target: "tasks" }),
  });
  return (await parseOrThrow(res)) as GoogleSyncApplyResponse;
}

export async function getGoogleTasksStatus(idToken: string, connectionId?: string): Promise<GoogleTasksStatus> {
  const query = `?target=tasks${connectionId ? `&connectionId=${encodeURIComponent(connectionId)}` : ""}`;
  const res = await fetch(`/api/google/sync/status${query}`, { headers: authHeaders(idToken) });
  return (await parseOrThrow(res)) as GoogleTasksStatus;
}

/** W4. Tasks sync is a separate switch from Calendar sync. Enabling creates the "Study Lamp" list and writes no tasks. */
export async function toggleGoogleTasks(idToken: string, connectionId: string, enabled: boolean): Promise<void> {
  const res = await fetch(`/api/google/connections/${encodeURIComponent(connectionId)}`, {
    method: "PATCH",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ tasks: { enabled } }),
  });
  await parseOrThrow(res);
}

export interface GoogleSyncApplyResult {
  itemId: string;
  status: "applied" | "stale" | "skipped" | "failed";
  code?: string;
}

export interface GoogleSyncApplyResponse {
  ok: boolean;
  results: GoogleSyncApplyResult[];
  applied: number;
  skipped: number;
  failed: number;
}

export async function applyGoogleSync(
  idToken: string,
  input: {
    planToken: string;
    accepted: string[];
    /** Keyed by itemId, or `${itemId}:${field}` for one field of a conflict. */
    resolutions?: Record<string, SyncResolution>;
    confirmedDestructive?: string[];
    connectionId?: string;
  },
): Promise<GoogleSyncApplyResponse> {
  const res = await fetch("/api/google/sync/apply", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify(input),
  });
  const data = await parseOrThrow(res);
  return data as GoogleSyncApplyResponse;
}

// ─── Z2: "Add to Google Doc / Sheet" (preview -> confirm -> apply) ──────────────────────────────

export type GoogleAppendTarget = "docs" | "sheets";
export type GoogleDocContentKind = "summary" | "notes" | "quiz_review";

/** `code` mirrors the server: stale | permission | not_found | reconnect | nothing_to_add | plan_already_applied | ... */
export class GoogleAppendError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "GoogleAppendError";
    this.code = code;
    this.status = status;
  }
}

export interface GoogleDocsAppendPreview {
  planToken: string;
  item: PlanItem;
  preview: { documentTitle: string; openUrl: string; kind: GoogleDocContentKind; kindLabel: string; heading: string; text: string; truncated: boolean };
}

export interface GoogleSheetsAppendPreview {
  planToken: string;
  item: PlanItem;
  preview: {
    documentTitle: string;
    openUrl: string;
    tab: string;
    willCreateTab: boolean;
    header: Array<string | number> | null;
    rows: Array<Array<string | number>>;
    remaining: number;
  };
}

async function parseAppendResponse<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new GoogleAppendError(
      typeof data?.error === "string" ? data.error : `Request failed (${res.status})`,
      typeof data?.code === "string" ? data.code : "error",
      res.status,
    );
  }
  return data as T;
}

/** Read-only. Returns the exact text the server would add, plus a signed plan token. Nothing is written. */
export async function previewGoogleDocAppend(idToken: string, documentId: string, content: GoogleDocContentKind): Promise<GoogleDocsAppendPreview> {
  const res = await fetch("/api/drive/docs/append/preview", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ documentId, content }),
  });
  return parseAppendResponse<GoogleDocsAppendPreview>(res);
}

export async function previewGoogleSheetAppend(idToken: string, documentId: string): Promise<GoogleSheetsAppendPreview> {
  const res = await fetch("/api/drive/sheets/append/preview", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ documentId }),
  });
  return parseAppendResponse<GoogleSheetsAppendPreview>(res);
}

/** The body is ONLY {planToken, accepted, documentId}; the server rebuilds the content itself. */
export async function applyGoogleAppend(
  idToken: string,
  target: GoogleAppendTarget,
  input: { planToken: string; accepted: string[]; documentId: string },
): Promise<{ ok: true; status: "applied"; warnings?: string[] }> {
  const res = await fetch(`/api/drive/${target}/append/apply`, {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ planToken: input.planToken, accepted: input.accepted, documentId: input.documentId }),
  });
  return parseAppendResponse(res);
}

// ─── W5: history and explicit removal ───────────────────────────────────────

/** Thrown when the number of items to remove changed between the preview and the confirmation. */
export class GoogleRemovalCountChangedError extends GoogleApiError {
  readonly count: number;
  constructor(message: string, count: number) {
    super(message, 409, "count_changed");
    this.name = "GoogleRemovalCountChangedError";
    this.count = count;
  }
}

/** Read-only. The newest sync log entries, newest first. Pass the returned `nextCursor` for the next page. */
export async function getGoogleSyncHistory(idToken: string, cursor?: string): Promise<{ entries: GoogleSyncHistoryEntry[]; nextCursor: string | null }> {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
  const res = await fetch(`/api/google/sync/history${query}`, { headers: authHeaders(idToken) });
  return (await parseOrThrow(res)) as { entries: GoogleSyncHistoryEntry[]; nextCursor: string | null };
}

/** Read-only. Counts what Study Lamp created for one connection (from Study Lamp's own records) and signs a plan token. */
export async function previewGoogleRemoval(idToken: string, input: { target: RemovalTarget; scope: RemovalScope; connectionId: string }): Promise<RemovalPreviewResult> {
  const res = await fetch("/api/google/sync/remove/preview", { method: "POST", headers: authHeaders(idToken, true), body: JSON.stringify(input) });
  return (await parseOrThrow(res)) as RemovalPreviewResult;
}

/** Deletes the previewed events/tasks. `confirmCount` is the number the user was shown; a different fresh count fails with GoogleRemovalCountChangedError. */
export async function applyGoogleRemoval(
  idToken: string,
  input: { planToken: string; confirmCount: number; target: RemovalTarget; scope: RemovalScope; connectionId: string },
): Promise<RemovalApplyResult> {
  const res = await fetch("/api/google/sync/remove", { method: "POST", headers: authHeaders(idToken, true), body: JSON.stringify(input) });
  if (res.status === 409) {
    const data = await res.clone().json().catch(() => ({}));
    if (data && data.code === "count_changed" && typeof data.count === "number") {
      throw new GoogleRemovalCountChangedError(typeof data.error === "string" ? data.error : "The number of items changed.", data.count);
    }
  }
  return (await parseOrThrow(res)) as RemovalApplyResult;
}

/** G7: how many old Drive records can be deleted safely (their unified twin exists), and how many are kept. */
export async function getLegacyDriveCleanupStatus(idToken: string): Promise<{ deletable: number; blocked: number }> {
  const res = await fetch("/api/google/cleanup-drive", { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return { deletable: Number(data.deletable) || 0, blocked: Number(data.blocked) || 0 };
}

/** G7: deletes the old Drive records that are safe to delete. Only call after the user confirmed the count. */
export async function runLegacyDriveCleanup(idToken: string): Promise<{ deleted: number; blocked: number }> {
  const res = await fetch("/api/google/cleanup-drive", { method: "POST", headers: authHeaders(idToken, true), body: JSON.stringify({ confirm: true }) });
  const data = await parseOrThrow(res);
  return { deleted: Number(data.deleted) || 0, blocked: Number(data.blocked) || 0 };
}

export interface DriveMigrationStatus {
  /** Old Drive connections that still need to be moved onto the unified Google connection. */
  pending: number;
}

export interface DriveMigrationResult {
  counts: { migrated: number; already_migrated: number; needs_drive_consent: number; skipped_invalid: number; verify_failed: number };
}

/** G5: how many old Drive connections are waiting to be moved (one cheap read). */
export async function getDriveMigrationStatus(idToken: string): Promise<DriveMigrationStatus> {
  const res = await fetch("/api/google/migrate-drive", { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return { pending: typeof data.pending === "number" ? data.pending : 0 };
}

/** G5: moves old Drive connections onto the unified connection. Only call after the user confirmed the count. */
export async function runDriveMigration(idToken: string): Promise<DriveMigrationResult> {
  const res = await fetch("/api/google/migrate-drive", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ confirm: true }),
  });
  const data = await parseOrThrow(res);
  return { counts: data.counts };
}

