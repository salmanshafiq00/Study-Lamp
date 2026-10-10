import admin from "firebase-admin";
import { adminDb } from "@/lib/server/firebase-admin";
import { encryptApiKey, decryptApiKey } from "@/lib/server/aiEncryption";
import { CalendarDeletedError, createCalendarClient, ensureStudyLampCalendar } from "@/lib/server/googleCalendar";
import { createTasksClient, ensureStudyLampTaskList, TasksListDeletedError, type TasksWriteClient } from "@/lib/server/googleTasks";
import { refreshWorkspaceAccessToken, revokeWorkspaceToken } from "@/lib/server/googleWorkspaceAuth";
import { isGoogleAuthInvalid } from "@/lib/server/googleOAuth";
import { DriveTokenCache } from "@/lib/server/driveTokenCache";
import { runWithDriveToken } from "@/lib/server/driveRequest";
import { type GoogleFeature, type GoogleWorkspaceFeature } from "@/lib/server/googleScopes";
import { googleDocHasDrive, isDriveOnlyConnection } from "@/lib/server/driveConnectionResolver";
import { listGoalSyncMappings } from "@/lib/server/googleSyncState";
import { computeSyncCounts, computeTasksSyncCounts, listOrphanMappings } from "@/lib/server/googleSyncMapping";
import type { GoogleCalendarConnection, GoogleConnectionSummary, GoogleSyncCounts, GoogleSyncOrphan, GoogleSyncStatus, GoogleTasksConnection, GoogleTasksStatus } from "@/types";

const DEFAULT_COUNTS: GoogleSyncCounts = {
  synced: 0,
  failed: 0,
  remoteDeleted: 0,
  unlinked: 0,
  noDate: 0,
  orphaned: 0,
};

// Reuse the same primitives as the Drive token path (Step W2 spec): a bounded
// in-memory access-token cache and the shared 401-retry wrapper.
const accessTokenCache = new DriveTokenCache(500, 60_000);
const lastUsedWriteAt = new Map<string, number>();
const LAST_USED_WRITE_INTERVAL_MS = 15 * 60_000;

function googleConnectionsRef(uid: string) {
  return adminDb.collection("users").doc(uid).collection("googleConnections");
}

/**
 * A thin seam over the connection docs, so the Tasks functions below can be tested with an in-memory fake (no emulator,
 * no Firebase). The default talks to Firestore through the Admin SDK exactly as before.
 */
export interface ConnectionDocSnap {
  id: string;
  exists: boolean;
  data(): FirebaseFirestore.DocumentData | undefined;
}
export interface ConnectionDocStore {
  get(uid: string, id: string): Promise<ConnectionDocSnap>;
  list(uid: string): Promise<ConnectionDocSnap[]>;
  update(uid: string, id: string, patch: Record<string, unknown>): Promise<void>;
}
export const firestoreConnectionStore: ConnectionDocStore = {
  get: (uid, id) => googleConnectionsRef(uid).doc(id).get(),
  list: async (uid) => (await googleConnectionsRef(uid).get()).docs,
  async update(uid, id, patch) {
    await googleConnectionsRef(uid).doc(id).update(patch);
  },
};

function cacheKey(uid: string, connectionId: string): string {
  return `${uid}:${connectionId}`;
}

function toIso(value: admin.firestore.Timestamp | null | undefined): string | null {
  return value ? value.toDate().toISOString() : null;
}

export function googleConnectionSummaryFrom(id: string, data: FirebaseFirestore.DocumentData): GoogleConnectionSummary {
  const grantedScopes = Array.isArray(data.grantedScopes) ? data.grantedScopes.filter((scope): scope is GoogleWorkspaceFeature => scope === "calendar" || scope === "tasks") : [];
  const calendarEnabled = Boolean(data.calendar?.enabled ?? data.enabled ?? false);
  const tasksEnabled = Boolean(data.tasks?.enabled ?? false);
  // EXACT key set returned to the browser. Tokens and ciphertext
  // (encryptedRefreshToken) are deliberately never included; a test asserts
  // this key set so a future field cannot leak silently.
  return {
    id,
    googleEmail: String(data.googleEmail ?? ""),
    status: data.status === "invalid" ? "invalid" : "active",
    grantedScopes,
    calendarEnabled,
    tasksEnabled,
    driveGranted: googleDocHasDrive(data),
    createdAt: toIso(data.createdAt ?? null),
    lastUsedAt: toIso(data.lastUsedAt ?? null),
  };
}

/** Calendar/Tasks list. A connection that exists only for Drive is shown on the Drive card, not here. */
export async function listGoogleConnections(uid: string): Promise<GoogleConnectionSummary[]> {
  const snap = await googleConnectionsRef(uid).orderBy("createdAt", "asc").get();
  return snap.docs.filter((doc) => !isDriveOnlyConnection(doc.data())).map((doc) => googleConnectionSummaryFrom(doc.id, doc.data()));
}

export async function getGoogleConnectionSummary(uid: string, id: string): Promise<GoogleConnectionSummary | null> {
  const snap = await googleConnectionsRef(uid).doc(id).get();
  if (!snap.exists) return null;
  return googleConnectionSummaryFrom(snap.id, snap.data()!);
}

export async function upsertGoogleConnection(
  uid: string,
  input: { googleEmail: string; refreshToken: string; grantedScopes: GoogleFeature[] },
): Promise<GoogleConnectionSummary> {
  const existing = await googleConnectionsRef(uid).where("googleEmail", "==", input.googleEmail).limit(1).get();
  const now = admin.firestore.FieldValue.serverTimestamp();
  const doc = {
    googleEmail: input.googleEmail,
    encryptedRefreshToken: encryptApiKey(input.refreshToken),
    grantedScopes: Array.from(new Set(input.grantedScopes)),
    status: "active",
    calendar: { enabled: false },
    tasks: { enabled: false },
    createdAt: now as any,
    updatedAt: now as any,
    lastUsedAt: null,
  };

  if (!existing.empty) {
    const ref = existing.docs[0].ref;
    const previous = existing.docs[0].data();
    await ref.set({
      ...doc,
      calendar: previous.calendar ?? { enabled: false },
      tasks: previous.tasks ?? { enabled: false },
      createdAt: previous.createdAt ?? now,
      lastUsedAt: previous.lastUsedAt ?? null,
      // MERGE rather than replace: an incremental "Allow Tasks access" flow
      // must never drop a Calendar grant the user already made.
      grantedScopes: Array.from(new Set([...(Array.isArray(previous.grantedScopes) ? previous.grantedScopes : []), ...doc.grantedScopes])),
      updatedAt: now,
    }, { merge: true });
    invalidateAccessToken(uid, ref.id);
    const snap = await ref.get();
    return googleConnectionSummaryFrom(snap.id, snap.data()!);
  }

  const ref = googleConnectionsRef(uid).doc();
  await ref.set(doc);
  invalidateAccessToken(uid, ref.id);
  const snap = await ref.get();
  return googleConnectionSummaryFrom(snap.id, snap.data()!);
}

export async function deleteGoogleConnection(uid: string, connectionId: string): Promise<boolean> {
  const ref = googleConnectionsRef(uid).doc(connectionId);
  const snap = await ref.get();
  if (!snap.exists) return false;
  invalidateAccessToken(uid, connectionId);
  const refreshToken = decryptApiKey(snap.data()!.encryptedRefreshToken);
  await revokeWorkspaceToken(refreshToken).catch(() => undefined);
  await ref.delete();
  // Step G5: this connection also carried Drive. Its legacy twin (the old driveConnections doc) holds a token for the
  // same Google account that is no longer wanted, and the Drive resolver must never fall back to it.
  const legacyId = snap.data()!.legacyDriveConnectionId;
  if (typeof legacyId === "string" && legacyId && !legacyId.includes("/")) {
    await adminDb.collection("users").doc(uid).collection("driveConnections").doc(legacyId).delete().catch(() => undefined);
  }
  return true;
}

export function invalidateAccessToken(uid: string, connectionId: string): void {
  const key = cacheKey(uid, connectionId);
  accessTokenCache.invalidate(key);
  lastUsedWriteAt.delete(key);
}

/**
 * Which connection to use when the caller did not name one (audit M2). Pure, so it can be tested without Firestore.
 *  - one candidate            -> that one (the common case)
 *  - several, exactly 1 on    -> the one that has the feature turned on
 *  - several, none on         -> "none": the feature simply is not turned on, which is NOT an error for a check
 *  - several, 2 or more on    -> "ambiguous": the user must keep it on for only one connection
 */
export type DefaultConnectionChoice = { kind: "ok"; id: string } | { kind: "none" } | { kind: "ambiguous" };

export function chooseDefaultConnection(candidates: ReadonlyArray<{ id: string; enabled: boolean }>): DefaultConnectionChoice {
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length === 1) return { kind: "ok", id: candidates[0].id };
  const enabled = candidates.filter((candidate) => candidate.enabled);
  if (enabled.length === 1) return { kind: "ok", id: enabled[0].id };
  return enabled.length === 0 ? { kind: "none" } : { kind: "ambiguous" };
}

export class GoogleConnectionError extends Error {
  code: "not_found" | "invalid" | "network" | "scope_missing" | "calendar_deleted" | "tasks_list_deleted" | "ambiguous";
  constructor(code: GoogleConnectionError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

/** Runs `operation` with a fresh access token for the connection. Delegates to
 *  the shared runWithDriveToken wrapper, which retries the operation once after
 *  a Google 401 (refreshing the token in between) and invalidates the cache.
 *  The optional `tokenProvider` is injectable for tests. */
export async function withGoogleAccessToken<T>(
  uid: string,
  connectionId: string,
  requiredFeature: GoogleWorkspaceFeature,
  operation: (accessToken: string) => Promise<T>,
  tokenProvider: () => Promise<string> = () => getAccessTokenForConnection(uid, connectionId, requiredFeature),
): Promise<T> {
  return runWithDriveToken(
    tokenProvider,
    () => invalidateAccessToken(uid, connectionId),
    operation,
  );
}

export interface GoogleAccessTokenDependencies {
  refreshAccessToken: typeof refreshWorkspaceAccessToken;
}

/** Pure scope check used by both the token path and its tests. */
export function grantedFeaturesOf(data: FirebaseFirestore.DocumentData): GoogleWorkspaceFeature[] {
  return Array.isArray(data.grantedScopes)
    ? data.grantedScopes.filter((scope: unknown): scope is GoogleWorkspaceFeature => scope === "calendar" || scope === "tasks")
    : [];
}

/** Pure core of the token path: refuses a connection missing `requiredFeature`
 *  (scope_missing), refreshes through the injected `refresh`, and classifies
 *  failures as invalid (revoked/expired refresh token) or network. Extracted so
 *  it can be unit-tested with an injected refresh function and no Firestore. */
export async function resolveGoogleAccessToken(
  data: FirebaseFirestore.DocumentData,
  requiredFeature: GoogleWorkspaceFeature,
  refresh: (refreshToken: string) => Promise<{ accessToken: string; expiresIn: number }>,
  now = Date.now(),
): Promise<{ token: string; expiresAt: number }> {
  if (!grantedFeaturesOf(data).includes(requiredFeature)) {
    throw new GoogleConnectionError("scope_missing", `This Google connection does not have ${requiredFeature} access enabled.`);
  }

  const refreshToken = decryptApiKey(data.encryptedRefreshToken);
  try {
    const { accessToken, expiresIn } = await refresh(refreshToken);
    return { token: accessToken, expiresAt: now + Math.max(0, expiresIn) * 1000 };
  } catch (error: unknown) {
    if (isGoogleAuthInvalid(error)) {
      throw new GoogleConnectionError("invalid", "This Google connection needs to be reconnected.");
    }
    throw new GoogleConnectionError("network", "Couldn't reach Google. Please try again shortly.");
  }
}

/** Returns a cached Workspace access token, refreshing it through the injected
 *  `refreshAccessToken` (defaults to the real Google call). Refuses a
 *  connection that is missing the required feature with a scope_missing error,
 *  marks the connection invalid on invalid_grant, and writes lastUsedAt at most
 *  once every 15 minutes. */
export async function getAccessTokenForConnection(
  uid: string,
  connectionId: string,
  requiredFeature: GoogleWorkspaceFeature,
  dependencies: Partial<GoogleAccessTokenDependencies> = {},
): Promise<string> {
  const key = cacheKey(uid, connectionId);
  return accessTokenCache.get(key, async () => {
    const ref = googleConnectionsRef(uid).doc(connectionId);
    const snap = await ref.get();
    if (!snap.exists) throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");

    const data = snap.data()!;
    const now = Date.now();
    const refresh = dependencies.refreshAccessToken ?? refreshWorkspaceAccessToken;

    let resolved: { token: string; expiresAt: number };
    try {
      resolved = await resolveGoogleAccessToken(data, requiredFeature, refresh, now);
    } catch (error) {
      if (error instanceof GoogleConnectionError && error.code === "invalid") {
        invalidateAccessToken(uid, connectionId);
        await ref.update({ status: "invalid", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
      throw error;
    }

    const storedLastUsedAt = typeof data.lastUsedAt?.toMillis === "function" ? data.lastUsedAt.toMillis() : 0;
    const lastWrittenAt = Math.max(storedLastUsedAt, lastUsedWriteAt.get(key) ?? 0);
    if (now - lastWrittenAt >= LAST_USED_WRITE_INTERVAL_MS) {
      try {
        await ref.update({ lastUsedAt: admin.firestore.FieldValue.serverTimestamp() });
        lastUsedWriteAt.set(key, now);
      } catch {
        // Usage metadata must never prevent using a valid token.
      }
    }

    return resolved;
  });
}

/** Connection ids are Firestore doc ids: non-empty, no slashes, bounded. Anything else is rejected before a lookup. */
export function isPlausibleConnectionId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && !value.includes("/");
}

export interface CalendarSettingsView {
  enabled: boolean;
  calendarId: string | null;
  calendarName: string | null;
  lastCheckAt: string | null;
}

/** Reads the `calendar` block of a connection doc. Pure. */
export function calendarSettingsFrom(data: FirebaseFirestore.DocumentData): CalendarSettingsView {
  const calendar = data.calendar && typeof data.calendar === "object" ? data.calendar : {};
  return {
    enabled: calendar.enabled === true,
    calendarId: typeof calendar.calendarId === "string" && calendar.calendarId ? calendar.calendarId : null,
    calendarName: typeof calendar.calendarName === "string" && calendar.calendarName ? calendar.calendarName : null,
    lastCheckAt: toIso(calendar.lastCheckAt ?? null),
  };
}

function hasUsableToken(data: FirebaseFirestore.DocumentData | undefined): data is FirebaseFirestore.DocumentData {
  return !!data && typeof data.encryptedRefreshToken === "string" && data.encryptedRefreshToken.length > 0;
}

function calendarConnectionFrom(id: string, data: FirebaseFirestore.DocumentData): GoogleCalendarConnection {
  const settings = calendarSettingsFrom(data);
  return {
    id,
    enabled: settings.enabled,
    calendarId: settings.calendarId,
    calendarName: settings.calendarName,
    lastSyncAt: settings.lastCheckAt,
    counts: { ...DEFAULT_COUNTS },
    createdAt: data.createdAt ?? null,
    updatedAt: data.updatedAt ?? null,
  };
}

/** Reads one connection (by its REAL doc id) as a Calendar view. Null if it does not exist or is not a real connection. */
export async function getGoogleCalendarConnection(uid: string, connectionId: string): Promise<GoogleCalendarConnection | null> {
  if (!isPlausibleConnectionId(connectionId)) return null;
  const snap = await googleConnectionsRef(uid).doc(connectionId).get();
  const data = snap.data();
  if (!snap.exists || !hasUsableToken(data)) return null;
  return calendarConnectionFrom(snap.id, data);
}

/**
 * Picks the connection a Calendar route should use. An explicit id must belong to this user and have the calendar
 * permission. Without one, the user must have exactly one connection with the calendar permission.
 */
export async function resolveCalendarConnectionId(uid: string, requestedId?: string | null): Promise<string> {
  if (requestedId) {
    if (!isPlausibleConnectionId(requestedId)) throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");
    const snap = await googleConnectionsRef(uid).doc(requestedId).get();
    if (!snap.exists || !hasUsableToken(snap.data())) throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");
    if (!grantedFeaturesOf(snap.data()!).includes("calendar")) throw new GoogleConnectionError("scope_missing", "This Google connection does not have calendar access enabled.");
    return snap.id;
  }

  const snap = await googleConnectionsRef(uid).get();
  const candidates = snap.docs.filter((doc) => hasUsableToken(doc.data()) && grantedFeaturesOf(doc.data()).includes("calendar"));
  if (candidates.length === 0) throw new GoogleConnectionError("not_found", "No Google connection with calendar access was found.");
  const choice = chooseDefaultConnection(candidates.map((doc) => ({ id: doc.id, enabled: calendarSettingsFrom(doc.data()).enabled })));
  if (choice.kind === "ok") return choice.id;
  if (choice.kind === "ambiguous") throw new GoogleConnectionError("ambiguous", "More than one Google connection has Calendar sync turned on.");
  throw new GoogleConnectionError("not_found", "Calendar sync is not turned on for any Google connection.");
}

/**
 * Turns Calendar sync on or off for one connection. Enabling verifies the stored calendar (calendars.get) or creates
 * "Study Lamp goals" (calendars.insert); it writes no events. Disabling only flips the flag.
 * A calendar that was deleted in Google is NOT silently re-created: the stored id is cleared, sync stays off, and
 * the caller gets "calendar_deleted"; the user must enable again explicitly.
 */
export async function setGoogleCalendarEnabled(uid: string, connectionId: string, enabled: boolean): Promise<GoogleCalendarConnection> {
  const ref = googleConnectionsRef(uid).doc(connectionId);
  const snap = await ref.get();
  if (!snap.exists || !hasUsableToken(snap.data())) {
    throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");
  }

  const now = admin.firestore.FieldValue.serverTimestamp();

  if (!enabled) {
    await ref.update({ "calendar.enabled": false, updatedAt: now });
  } else {
    if (!grantedFeaturesOf(snap.data()!).includes("calendar")) {
      throw new GoogleConnectionError("scope_missing", "This Google connection does not have calendar access enabled.");
    }

    const accessToken = await getAccessTokenForConnection(uid, connectionId, "calendar");
    const client = createCalendarClient(accessToken);
    const stored = calendarSettingsFrom(snap.data()!);

    try {
      const calendar = await ensureStudyLampCalendar(client, stored.calendarId, "Study Lamp goals");
      await ref.update({
        "calendar.enabled": true,
        "calendar.calendarId": calendar.id,
        "calendar.calendarName": calendar.summary,
        updatedAt: now,
      });
    } catch (error) {
      if (error instanceof CalendarDeletedError) {
        await ref.update({ "calendar.enabled": false, "calendar.calendarId": null, "calendar.calendarName": null, updatedAt: now });
        throw new GoogleConnectionError("calendar_deleted", "The Study Lamp calendar was deleted in Google.");
      }
      throw error;
    }
  }

  const saved = await ref.get();
  return calendarConnectionFrom(saved.id, saved.data()!);
}

/** Records that a Calendar check/apply ran. Only called from the apply step, never from a preview. */
export async function touchCalendarLastCheck(uid: string, connectionId: string): Promise<void> {
  await googleConnectionsRef(uid).doc(connectionId).update({ "calendar.lastCheckAt": admin.firestore.FieldValue.serverTimestamp() });
}

export async function getGoogleSyncStatus(uid: string, requestedConnectionId?: string | null): Promise<GoogleSyncStatus> {
  let connection: GoogleCalendarConnection | null = null;
  try {
    connection = await getGoogleCalendarConnection(uid, await resolveCalendarConnectionId(uid, requestedConnectionId));
  } catch (error) {
    // "ambiguous" is NOT swallowed: the caller must tell the user to choose one connection (audit M2).
    if (!(error instanceof GoogleConnectionError) || error.code === "ambiguous") throw error;
  }
  // Counts come from our own mapping and goal docs only: no Google call, no write.
  let counts: GoogleSyncCounts = { ...DEFAULT_COUNTS };
  let orphans: GoogleSyncOrphan[] = [];
  if (connection?.enabled && connection.calendarId) {
    const [mappings, goalSnap] = await Promise.all([
      listGoalSyncMappings(uid),
      adminDb.collection("users").doc(uid).collection("goals").select("targetDate").get(),
    ]);
    counts = computeSyncCounts({
      mappings,
      goals: goalSnap.docs.map((doc) => ({ id: doc.id, targetDate: typeof doc.data().targetDate === "string" ? doc.data().targetDate : null })),
      calendarId: connection.calendarId,
    });
    orphans = listOrphanMappings({ mappings, goalIds: new Set(goalSnap.docs.map((doc) => doc.id)), block: "calendar", containerId: connection.calendarId });
  }
  return {
    enabled: Boolean(connection?.enabled),
    connectionId: connection?.id ?? null,
    calendarName: connection?.calendarName ?? null,
    lastSyncAt: connection?.lastSyncAt ?? null,
    counts,
    orphans,
  };
}

// ─── Tasks (W4) ─────────────────────────────────────────────────────────────

export interface TasksSettingsView {
  enabled: boolean;
  listId: string | null;
  listName: string | null;
  lastCheckAt: string | null;
}

/** Reads the `tasks` block of a connection doc. Pure. */
export function tasksSettingsFrom(data: FirebaseFirestore.DocumentData): TasksSettingsView {
  const tasks = data.tasks && typeof data.tasks === "object" ? data.tasks : {};
  return {
    enabled: tasks.enabled === true,
    listId: typeof tasks.listId === "string" && tasks.listId ? tasks.listId : null,
    listName: typeof tasks.listName === "string" && tasks.listName ? tasks.listName : null,
    lastCheckAt: toIso(tasks.lastCheckAt ?? null),
  };
}

function tasksConnectionFrom(id: string, data: FirebaseFirestore.DocumentData): GoogleTasksConnection {
  const settings = tasksSettingsFrom(data);
  return { id, enabled: settings.enabled, listId: settings.listId, listName: settings.listName, lastSyncAt: settings.lastCheckAt };
}

export async function getGoogleTasksConnection(uid: string, connectionId: string, store: ConnectionDocStore = firestoreConnectionStore): Promise<GoogleTasksConnection | null> {
  if (!isPlausibleConnectionId(connectionId)) return null;
  const snap = await store.get(uid, connectionId);
  const data = snap.data();
  if (!snap.exists || !hasUsableToken(data)) return null;
  return tasksConnectionFrom(snap.id, data);
}

/** Same rule as the Calendar resolver, for the `tasks` permission. */
export async function resolveTasksConnectionId(uid: string, requestedId?: string | null, store: ConnectionDocStore = firestoreConnectionStore): Promise<string> {
  if (requestedId) {
    if (!isPlausibleConnectionId(requestedId)) throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");
    const snap = await store.get(uid, requestedId);
    if (!snap.exists || !hasUsableToken(snap.data())) throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");
    if (!grantedFeaturesOf(snap.data()!).includes("tasks")) throw new GoogleConnectionError("scope_missing", "This Google connection does not have tasks access enabled.");
    return snap.id;
  }
  const docs = await store.list(uid);
  const candidates = docs.filter((doc) => hasUsableToken(doc.data()) && grantedFeaturesOf(doc.data()!).includes("tasks"));
  if (candidates.length === 0) throw new GoogleConnectionError("not_found", "No Google connection with tasks access was found.");
  const choice = chooseDefaultConnection(candidates.map((doc) => ({ id: doc.id, enabled: tasksSettingsFrom(doc.data()!).enabled })));
  if (choice.kind === "ok") return choice.id;
  if (choice.kind === "ambiguous") throw new GoogleConnectionError("ambiguous", "More than one Google connection has Tasks sync turned on.");
  throw new GoogleConnectionError("not_found", "Tasks sync is not turned on for any Google connection.");
}

/**
 * Turns Tasks sync on or off for one connection. Enabling verifies the stored list (tasklists.get) or creates the
 * "Study Lamp" list (tasklists.insert); it writes no tasks. A list deleted in Google is NOT silently re-created: the
 * stored id is cleared, sync stays off, and the user must enable again explicitly.
 */
export interface SetTasksEnabledDeps {
  store?: ConnectionDocStore;
  /** Builds the Google Tasks client for the connection. Default: refresh the stored token and call the real API. */
  tasksClient?: (uid: string, connectionId: string) => Promise<Pick<TasksWriteClient, "getTaskList" | "createTaskList">>;
}

export async function setGoogleTasksEnabled(uid: string, connectionId: string, enabled: boolean, deps: SetTasksEnabledDeps = {}): Promise<GoogleTasksConnection> {
  const store = deps.store ?? firestoreConnectionStore;
  const tasksClient = deps.tasksClient ?? (async (clientUid: string, clientConnectionId: string) => createTasksClient(await getAccessTokenForConnection(clientUid, clientConnectionId, "tasks")));
  const snap = await store.get(uid, connectionId);
  if (!snap.exists || !hasUsableToken(snap.data())) throw new GoogleConnectionError("not_found", "This Google connection no longer exists.");
  const now = admin.firestore.FieldValue.serverTimestamp();

  if (!enabled) {
    await store.update(uid, connectionId, { "tasks.enabled": false, updatedAt: now });
  } else {
    if (!grantedFeaturesOf(snap.data()!).includes("tasks")) throw new GoogleConnectionError("scope_missing", "This Google connection does not have tasks access enabled.");
    const client = await tasksClient(uid, connectionId);
    const stored = tasksSettingsFrom(snap.data()!);
    try {
      const list = await ensureStudyLampTaskList(client, stored.listId, "Study Lamp");
      await store.update(uid, connectionId, { "tasks.enabled": true, "tasks.listId": list.id, "tasks.listName": list.title, updatedAt: now });
    } catch (error) {
      if (error instanceof TasksListDeletedError) {
        await store.update(uid, connectionId, { "tasks.enabled": false, "tasks.listId": null, "tasks.listName": null, updatedAt: now });
        throw new GoogleConnectionError("tasks_list_deleted", "The Study Lamp task list was deleted in Google.");
      }
      throw error;
    }
  }
  const saved = await store.get(uid, connectionId);
  return tasksConnectionFrom(saved.id, saved.data()!);
}

/** Records that a Tasks apply ran. Only called from the apply step, never from a preview. */
export async function touchTasksLastCheck(uid: string, connectionId: string): Promise<void> {
  await googleConnectionsRef(uid).doc(connectionId).update({ "tasks.lastCheckAt": admin.firestore.FieldValue.serverTimestamp() });
}

/** Counts from our own mapping and goal docs only: no Google call, no write. */
export interface TasksStatusDeps {
  store?: ConnectionDocStore;
  listMappings?: (uid: string) => ReturnType<typeof listGoalSyncMappings>;
  listGoalIds?: (uid: string) => Promise<string[]>;
}

export async function getGoogleTasksStatus(uid: string, requestedConnectionId?: string | null, deps: TasksStatusDeps = {}): Promise<GoogleTasksStatus> {
  const store = deps.store ?? firestoreConnectionStore;
  const listMappings = deps.listMappings ?? listGoalSyncMappings;
  const listGoalIds = deps.listGoalIds ?? (async (statusUid: string) => (await adminDb.collection("users").doc(statusUid).collection("goals").select().get()).docs.map((doc) => doc.id));
  let connection: GoogleTasksConnection | null = null;
  try {
    connection = await getGoogleTasksConnection(uid, await resolveTasksConnectionId(uid, requestedConnectionId, store), store);
  } catch (error) {
    // "ambiguous" is NOT swallowed: the caller must tell the user to choose one connection (audit M2).
    if (!(error instanceof GoogleConnectionError) || error.code === "ambiguous") throw error;
  }
  let counts: GoogleSyncCounts = { ...DEFAULT_COUNTS };
  let orphans: GoogleSyncOrphan[] = [];
  if (connection?.enabled && connection.listId) {
    const [mappings, goalIds] = await Promise.all([listMappings(uid), listGoalIds(uid)]);
    counts = computeTasksSyncCounts({ mappings, goalIds: new Set(goalIds), listId: connection.listId });
    orphans = listOrphanMappings({ mappings, goalIds: new Set(goalIds), block: "tasks", containerId: connection.listId });
  }
  return { enabled: Boolean(connection?.enabled), connectionId: connection?.id ?? null, listName: connection?.listName ?? null, lastSyncAt: connection?.lastSyncAt ?? null, counts, orphans };
}
