import type { DriveConnectionSummary } from "@/types";

// Thin client-side wrappers around the /api/drive/* routes, mirroring the
// pattern in src/lib/aiConnectionsClient.ts.

async function parseOrThrow(res: Response): Promise<any> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function authHeaders(idToken: string, withJson = false): HeadersInit {
  return {
    Authorization: `Bearer ${idToken}`,
    ...(withJson ? { "Content-Type": "application/json" } : {}),
  };
}

export async function listDriveConnections(idToken: string): Promise<DriveConnectionSummary[]> {
  const res = await fetch("/api/drive/connections", { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return data.connections;
}

export async function disconnectDrive(idToken: string, connectionId: string): Promise<void> {
  const res = await fetch(`/api/drive/connections/${connectionId}`, { method: "DELETE", headers: authHeaders(idToken) });
  await parseOrThrow(res);
}

/** Kicks off the OAuth connect flow for Drive and navigates to the server-built Google auth URL.
 *  Since G5 this is the unified Google flow with only the Drive feature: Google asks for drive.file alone
 *  (include_granted_scopes keeps any Calendar/Tasks grant) and redirects back to /settings/google?tab=drive
 *  through /api/google/auth/callback. */
export async function startDriveConnect(idToken: string): Promise<void> {
  const res = await fetch("/api/google/auth/state", { method: "POST", headers: authHeaders(idToken, true), body: JSON.stringify({ features: ["drive"] }) });
  const data = await parseOrThrow(res);
  if (typeof data.url !== "string" || !data.url.startsWith("https://accounts.google.com/")) {
    throw new Error("Google Drive returned an invalid authorization URL.");
  }
  window.location.href = data.url;
}

/** Short-lived (~1hr) access token for client-side use by the Google Picker
 *  only. Never stored beyond the Picker session. */
export async function getDriveAccessToken(idToken: string, connectionId: string): Promise<string> {
  return (await getDrivePickerAuth(idToken, connectionId)).accessToken;
}

/** Token plus the Google Cloud project number the Picker needs as its App ID (null when unknown). */
export async function getDrivePickerAuth(idToken: string, connectionId: string): Promise<{ accessToken: string; appId: string | null }> {
  const res = await fetch(`/api/drive/access-token?connectionId=${encodeURIComponent(connectionId)}`, { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return { accessToken: data.accessToken, appId: typeof data.appId === "string" ? data.appId : null };
}

/** Read-only Drive check for a Google Doc/Sheet; updates the stored modifiedTime when it changed. */
export async function refreshGoogleDocumentMeta(idToken: string, documentId: string): Promise<{ modifiedTime: string | null; changed: boolean }> {
  const res = await fetch(`/api/documents/${encodeURIComponent(documentId)}/refresh`, { method: "POST", headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return { modifiedTime: typeof data.modifiedTime === "string" ? data.modifiedTime : null, changed: data.changed === true };
}

export interface DriveImportResult {
  kind: "video" | "document";
  playlistId?: string;
  videoId?: string;
  documentId?: string;
}

export type DriveSignedUrlPurpose = "stream" | "download" | "thumb" | "export" | "export_download";

export interface DriveSignedUrlItem {
  fileId: string;
  connectionId: string;
  purpose: DriveSignedUrlPurpose;
}

interface CachedSignedUrl {
  url: string;
  exp: number;
}

interface PendingSignedUrl extends DriveSignedUrlItem {
  uid: string;
  idToken: string;
  resolve: (url: string) => void;
  reject: (error: Error) => void;
}

/** One entry of the /api/drive/sign response; `error` marks a per-item failure. */
interface SignedUrlResponseItem {
  fileId?: unknown;
  connectionId?: unknown;
  purpose?: unknown;
  url?: unknown;
  exp?: unknown;
  error?: unknown;
}

const signedUrlCache = new Map<string, CachedSignedUrl>();
const pendingSignedUrls: PendingSignedUrl[] = [];
const SIGNED_URL_REFRESH_BUFFER_MS = 5 * 60_000;
const SIGNED_URL_CACHE_MAX_ENTRIES = 500;
/** Requests made within this window are sent as ONE /api/drive/sign call.
 *  (A microtask flushed before most components finished awaiting
 *  user.getIdToken(), which produced many tiny batches.) */
const SIGN_FLUSH_DELAY_MS = 25;
/** Max items per /api/drive/sign request (the server accepts up to 50). */
const SIGN_BATCH_SIZE = 50;
let signFlushTimer: ReturnType<typeof setTimeout> | null = null;

function signedUrlCacheKey(uid: string, item: DriveSignedUrlItem): string {
  return `${uid}:${item.purpose}:${item.connectionId}:${item.fileId}`;
}

function scheduleSignFlush(delayMs: number): void {
  if (signFlushTimer) return;
  signFlushTimer = setTimeout(() => {
    signFlushTimer = null;
    void flushSignedUrlQueue();
  }, delayMs);
}

function queueSignedUrl(item: DriveSignedUrlItem, uid: string, idToken: string): Promise<string> {
  const key = signedUrlCacheKey(uid, item);
  const cached = signedUrlCache.get(key);
  if (cached && cached.exp * 1000 - SIGNED_URL_REFRESH_BUFFER_MS > Date.now()) {
    signedUrlCache.delete(key);
    signedUrlCache.set(key, cached);
    return Promise.resolve(cached.url);
  }

  return new Promise((resolve, reject) => {
    pendingSignedUrls.push({ ...item, uid, idToken, resolve, reject });
    // A full batch goes out right away; otherwise wait a short window so
    // concurrent requests share one round trip.
    if (pendingSignedUrls.length >= SIGN_BATCH_SIZE) {
      if (signFlushTimer) {
        clearTimeout(signFlushTimer);
        signFlushTimer = null;
      }
      void flushSignedUrlQueue();
    } else {
      scheduleSignFlush(SIGN_FLUSH_DELAY_MS);
    }
  });
}

function rememberSignedUrl(entryKey: string, signed: CachedSignedUrl): void {
  signedUrlCache.delete(entryKey);
  signedUrlCache.set(entryKey, signed);
  while (signedUrlCache.size > SIGNED_URL_CACHE_MAX_ENTRIES) {
    const oldestKey = signedUrlCache.keys().next().value;
    if (oldestKey === undefined) break;
    signedUrlCache.delete(oldestKey);
  }
}

async function flushSignedUrlQueue(): Promise<void> {
  const batch = pendingSignedUrls.splice(0, SIGN_BATCH_SIZE);
  if (pendingSignedUrls.length) scheduleSignFlush(0);
  if (batch.length === 0) return;

  const byUser = new Map<string, PendingSignedUrl[]>();
  for (const entry of batch) {
    const entries = byUser.get(entry.uid) || [];
    entries.push(entry);
    byUser.set(entry.uid, entries);
  }

  await Promise.all(Array.from(byUser.values(), async (userEntries) => {
    // Identical requests in the same window share one item in the payload.
    const byKey = new Map<string, PendingSignedUrl[]>();
    for (const entry of userEntries) {
      const key = signedUrlCacheKey(entry.uid, entry);
      const group = byKey.get(key);
      if (group) group.push(entry);
      else byKey.set(key, [entry]);
    }
    const groups = Array.from(byKey.entries());
    const first = userEntries[0];

    try {
      const res = await fetch("/api/drive/sign", {
        method: "POST",
        headers: authHeaders(first.idToken, true),
        body: JSON.stringify({
          items: groups.map(([, [entry]]) => ({ fileId: entry.fileId, connectionId: entry.connectionId, purpose: entry.purpose })),
        }),
      });
      const data = await parseOrThrow(res);
      if (!Array.isArray(data.urls) || data.urls.length !== groups.length) {
        throw new Error("Google Drive returned an incomplete signed URL response.");
      }

      // Each item succeeds or fails on its own; one unowned file must not
      // reject the thumbnails/streams that were signed fine.
      groups.forEach(([key, entries], index) => {
        const signed = data.urls[index] as SignedUrlResponseItem | null;
        const reference = entries[0];
        if (
          !signed || typeof signed !== "object" ||
          signed.fileId !== reference.fileId || signed.purpose !== reference.purpose
        ) {
          entries.forEach((entry) => entry.reject(new Error("Google Drive returned an invalid signed URL.")));
        } else if (signed.error !== undefined) {
          const message = signed.error === "not_found" ? "This Drive file wasn't found." : "Couldn't prepare a Drive URL.";
          entries.forEach((entry) => entry.reject(new Error(message)));
        } else if (typeof signed.url !== "string" || typeof signed.exp !== "number") {
          entries.forEach((entry) => entry.reject(new Error("Google Drive returned an invalid signed URL.")));
        } else {
          rememberSignedUrl(key, { url: signed.url, exp: signed.exp });
          entries.forEach((entry) => entry.resolve(signed.url as string));
        }
      });
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error("Couldn't prepare a Drive URL.");
      userEntries.forEach((entry) => entry.reject(normalized));
    }
  }));
}

export async function getSignedDriveUrls(
  idToken: string,
  uid: string,
  items: DriveSignedUrlItem[],
): Promise<string[]> {
  return Promise.all(items.map((item) => queueSignedUrl(item, uid, idToken)));
}

export async function refreshSignedDriveUrl(
  idToken: string,
  uid: string,
  item: DriveSignedUrlItem,
): Promise<string> {
  signedUrlCache.delete(signedUrlCacheKey(uid, item));
  const [url] = await getSignedDriveUrls(idToken, uid, [item]);
  return url;
}

export async function backfillDriveThumbnails(idToken: string): Promise<{ processed: number; remaining: number }> {
  const res = await fetch("/api/drive/thumbnails/backfill", {
    method: "POST",
    headers: authHeaders(idToken),
  });
  return parseOrThrow(res);
}

export async function importDriveFile(
  idToken: string,
  input: { connectionId: string; fileId: string; playlistId?: string }
): Promise<DriveImportResult> {
  const res = await fetch("/api/drive/import/file", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify(input),
  });
  return parseOrThrow(res);
}

/** Result of importing a folder. `needsSelection` means Google hid the folder's
 *  children from this app (drive.file scope): reopen the Picker scoped to the folder. */
export type DriveFolderImportResult =
  | { playlistId: string; videoCount: number; needsSelection?: undefined }
  | { needsSelection: true; folderId: string; folderName: string };

export async function importDriveFolder(
  idToken: string,
  input: { connectionId: string; folderId: string }
): Promise<DriveFolderImportResult> {
  const res = await fetch("/api/drive/import/folder", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify(input),
  });
  return parseOrThrow(res);
}

export type DriveImportTarget =
  | { type: "new_playlist"; title?: string }
  | { type: "existing_playlist"; playlistId: string }
  | { type: "unsorted" }
  | { type: "documents" };

export interface DriveBulkImportResult {
  playlistId?: string;
  addedVideos: number;
  addedDocuments: number;
  skipped: Array<{ fileId: string; reason: string }>;
  duplicates: number;
}

/** The server accepts at most this many files per request. */
export const DRIVE_BULK_IMPORT_MAX_FILES = 200;

/**
 * One request for a whole multi-select (POST /api/drive/import/files). Selections
 * above the server's 200-file cap are split into several requests; for a new
 * playlist the first request creates it and the rest append to it.
 */
export async function importDriveFiles(
  idToken: string,
  input: { connectionId: string; fileIds: string[]; target: DriveImportTarget }
): Promise<DriveBulkImportResult> {
  const total: DriveBulkImportResult = { addedVideos: 0, addedDocuments: 0, skipped: [], duplicates: 0 };
  let target = input.target;
  for (let offset = 0; offset < input.fileIds.length; offset += DRIVE_BULK_IMPORT_MAX_FILES) {
    const res = await fetch("/api/drive/import/files", {
      method: "POST",
      headers: authHeaders(idToken, true),
      body: JSON.stringify({
        connectionId: input.connectionId,
        fileIds: input.fileIds.slice(offset, offset + DRIVE_BULK_IMPORT_MAX_FILES),
        target,
      }),
    });
    const data = await parseOrThrow(res) as DriveBulkImportResult;
    total.addedVideos += data.addedVideos;
    total.addedDocuments += data.addedDocuments;
    total.duplicates += data.duplicates;
    total.skipped.push(...data.skipped);
    if (data.playlistId) {
      total.playlistId = data.playlistId;
      if (target.type === "new_playlist") target = { type: "existing_playlist", playlistId: data.playlistId };
    }
  }
  return total;
}

export async function startDriveUploadSession(
  idToken: string,
  input: { connectionId: string; name: string; mimeType: string; sizeBytes: number }
): Promise<string> {
  const res = await fetch("/api/drive/upload/session", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify(input),
  });
  const data = await parseOrThrow(res);
  return data.uploadUrl;
}

/** Uploads bytes straight to Google's resumable session URL — no
 *  Authorization header needed here (see startResumableUpload's comment in
 *  googleDrive.ts). Reports progress via onProgress(0-100) using XHR since
 *  fetch doesn't expose upload progress. */
export function uploadFileToDrive(uploadUrl: string, file: File, onProgress?: (pct: number) => void): Promise<{ id: string; name: string; mimeType: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", uploadUrl, true);
    xhr.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("Drive returned an unexpected response after upload."));
        }
      } else {
        reject(new Error(`Upload to Drive failed (${xhr.status}).`));
      }
    };
    xhr.onerror = () => reject(new Error("Upload to Drive failed (network error)."));
    xhr.send(file);
  });
}

export interface BackupSummary {
  fileId: string;
  name: string;
  createdAt?: string;
  counts?: Record<string, number>;
}

export async function createDriveBackup(idToken: string, connectionId: string): Promise<BackupSummary> {
  const res = await fetch("/api/drive/backup", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ connectionId }),
  });
  return parseOrThrow(res);
}

export async function listDriveBackups(idToken: string, connectionId: string): Promise<{ fileId: string; name: string }[]> {
  const res = await fetch(`/api/drive/backup/list?connectionId=${encodeURIComponent(connectionId)}`, { headers: authHeaders(idToken) });
  const data = await parseOrThrow(res);
  return data.backups;
}

export interface RestorePreview {
  confirmed: boolean;
  playlistsToRestore: number;
  videosToRestore: number;
  notesToRestore: number;
  summariesToRestore: number;
  goalsToRestore: number;
  quizAttemptsToRestore: number;
  playlistTitles: string[];
}

export async function previewDriveRestore(idToken: string, connectionId: string, fileId: string): Promise<RestorePreview> {
  const res = await fetch("/api/drive/backup/restore", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ connectionId, fileId, confirm: false }),
  });
  return parseOrThrow(res);
}

export async function confirmDriveRestore(idToken: string, connectionId: string, fileId: string): Promise<RestorePreview> {
  const res = await fetch("/api/drive/backup/restore", {
    method: "POST",
    headers: authHeaders(idToken, true),
    body: JSON.stringify({ connectionId, fileId, confirm: true }),
  });
  return parseOrThrow(res);
}