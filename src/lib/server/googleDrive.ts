import crypto from "crypto";
import { nativeExportMime } from "@/lib/driveMime";
import { DRIVE_ERROR_MESSAGES, classifyDriveExportError, extractGoogleErrorReason, type DriveErrorCode } from "@/lib/driveErrors";
import {
  buildGoogleAuthUrl,
  exchangeCode,
  fetchGoogleAccountEmail,
  refreshToken,
  revoke,
  type GoogleOAuthClient,
} from "@/lib/server/googleOAuth";

/**
 * Server-only. Raw REST wrapper around Google's OAuth2 + Drive v3 APIs —
 * deliberately implemented with plain fetch() rather than the `googleapis`
 * npm package, so Phase 13-17 don't add a heavy new dependency for what
 * amounts to a handful of endpoints (token exchange/refresh, files.get/
 * list/create, and the resumable upload initiate call).
 *
 * Drive access stays limited to https://www.googleapis.com/auth/drive.file —
 * Study Lamp can only see files it created or that the user explicitly picked
 * via the Google Picker (see src/components/drive/DrivePicker.tsx). The
 * userinfo.email scope is also requested so the callback can identify the
 * connected Google account; it does not grant additional Drive access.
 *
 * Required env vars (server-only, never NEXT_PUBLIC_):
 *   GOOGLE_DRIVE_CLIENT_ID
 *   GOOGLE_DRIVE_CLIENT_SECRET
 *   GOOGLE_DRIVE_OAUTH_STATE_SECRET  (generate with: openssl rand -base64 32)
 * Plus one public var so the browser can start the OAuth redirect and open
 * the Picker with the same client id:
 *   NEXT_PUBLIC_GOOGLE_DRIVE_CLIENT_ID
 *   NEXT_PUBLIC_GOOGLE_PICKER_API_KEY  (a browser API key restricted to the
 *     Picker API — see https://console.cloud.google.com/apis/credentials)
 */

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
const DRIVE_REDIRECT_PATH = "/api/drive/auth/callback";
const DRIVE_API = "https://www.googleapis.com/drive/v3";
const DRIVE_UPLOAD_API = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,128}$/;
const DRIVE_CONNECTION_ID_PATTERN = /^[A-Za-z0-9]{10,40}$/;
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export function isValidDriveId(id: unknown): id is string {
  return typeof id === "string" && DRIVE_ID_PATTERN.test(id);
}

export function assertDriveId(id: string): void {
  if (!isValidDriveId(id)) throw new Error("Invalid Google Drive file or folder ID.");
}

export function isValidDriveConnectionId(id: unknown): id is string {
  return typeof id === "string" && DRIVE_CONNECTION_ID_PATTERN.test(id);
}

export function sanitizeDriveFileName(name: string): string {
  return name.replace(/[\\/\u0000-\u001f\u007f]/g, "").trim().slice(0, 200);
}

export function isSupportedUploadMimeType(mimeType: string): boolean {
  return mimeType.startsWith(SUPPORTED_VIDEO_MIME_PREFIX) ||
    SUPPORTED_DOCUMENT_MIME_TYPES.includes(mimeType as typeof SUPPORTED_DOCUMENT_MIME_TYPES[number]);
}

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured. See src/lib/server/googleDrive.ts for the full list of required env vars.`);
  return v;
}

export function isDriveConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_DRIVE_CLIENT_ID &&
    process.env.GOOGLE_DRIVE_CLIENT_SECRET &&
    process.env.GOOGLE_DRIVE_OAUTH_STATE_SECRET
  );
}

/** The Drive OAuth client config, passed to the generic primitives. */
function driveClient(): GoogleOAuthClient {
  return { clientId: env("GOOGLE_DRIVE_CLIENT_ID"), clientSecret: env("GOOGLE_DRIVE_CLIENT_SECRET"), redirectPath: DRIVE_REDIRECT_PATH };
}

/** Builds the redirect_uri from the request's own origin rather than a
 *  hardcoded env var, so this works unchanged across localhost/preview/prod
 *  deployments — it only has to match one of the "Authorized redirect URIs"
 *  configured on the OAuth client in Google Cloud Console. */
export function buildRedirectUri(origin: string): string {
  return `${origin}${DRIVE_REDIRECT_PATH}`;
}

// ── OAuth "state" — binds the redirect round-trip to the signed-in uid ─────
// Google's callback is a plain browser GET with no Authorization header, so
// the state param is how we know *which* Study Lamp user is connecting.
// Signed (HMAC-SHA256) and short-lived (10 min) so it can't be forged or replayed.
const STATE_TTL_MS = 10 * 60 * 1000;

export function signDriveState(
  uid: string,
  nonce = crypto.randomBytes(32).toString("base64url"),
  now = Date.now(),
): string {
  const payload = `${uid}.${now}.${nonce}`;
  const sig = crypto.createHmac("sha256", env("GOOGLE_DRIVE_OAUTH_STATE_SECRET")).update(payload).digest("hex");
  return Buffer.from(`${payload}.${sig}`).toString("base64url");
}

export function verifyDriveState(
  state: string,
  expectedNonce: string | null,
  now = Date.now(),
): { uid: string; nonce: string } | null {
  try {
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    const parts = decoded.split(".");
    if (parts.length !== 4) return null;
    const [uid, tsRaw, nonce, sig] = parts;
    const payload = `${uid}.${tsRaw}.${nonce}`;
    const expected = crypto.createHmac("sha256", env("GOOGLE_DRIVE_OAUTH_STATE_SECRET")).update(payload).digest("hex");
    const sigBuffer = Buffer.from(sig);
    const expectedBuffer = Buffer.from(expected);
    if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) return null;
    const ts = Number(tsRaw);
    const nonceBytes = Buffer.from(nonce, "base64url");
    if (!uid || !Number.isFinite(ts) || ts > now || now - ts > STATE_TTL_MS || nonceBytes.length !== 32) return null;
    if (!expectedNonce || !sameText(nonce, expectedNonce)) return null;
    return { uid, nonce };
  } catch {
    return null;
  }
}

function sameText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function buildAuthUrl(origin: string, state: string): string {
  return buildGoogleAuthUrl(origin, state, driveClient(), {
    scope: DRIVE_SCOPE,
    accessType: "offline",
    // Forces Google to re-issue a refresh_token even for a user who
    // connected before — without this, re-connecting after a disconnect
    // would silently come back with no refresh_token at all.
    prompt: "consent",
  });
}

interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
}

export async function exchangeCodeForTokens(code: string, origin: string): Promise<TokenResponse> {
  const tokens = await exchangeCode(code, origin, driveClient());
  // Drive's callers rely on `scope` being present (it is recorded on the
  // connection); default to the requested DRIVE_SCOPE if Google omits it.
  return { ...tokens, scope: tokens.scope ?? DRIVE_SCOPE };
}

/** Returns a fresh short-lived access token for a stored refresh token.
 *  Never persisted — callers use it immediately for one or a few Drive API
 *  calls and then discard it. */
export async function refreshAccessToken(refreshTokenValue: string): Promise<{ accessToken: string; expiresIn: number }> {
  return refreshToken(refreshTokenValue, driveClient());
}

export async function revokeToken(token: string): Promise<void> {
  return revoke(token);
}

export async function getGoogleAccountEmail(accessToken: string): Promise<string> {
  return fetchGoogleAccountEmail(accessToken);
}

// ── Drive v3 file operations ────────────────────────────────────────────

export interface DriveFileMeta {
  id: string;
  name: string;
  mimeType: string;
  size?: string;
  md5Checksum?: string;
  modifiedTime?: string;
  thumbnailLink?: string;
  videoMediaMetadata?: { durationMillis?: string; width?: number; height?: number };
  parents?: string[];
}

export class DriveApiError extends Error {
  constructor(readonly status: number, message: string, readonly code?: DriveErrorCode) {
    super(message);
    this.name = "DriveApiError";
  }
}

const FILE_FIELDS = "id,name,mimeType,size,md5Checksum,modifiedTime,thumbnailLink,videoMediaMetadata,parents";

export async function getFileMetadata(accessToken: string, fileId: string): Promise<DriveFileMeta> {
  assertDriveId(fileId);
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?fields=${FILE_FIELDS}&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (res.status === 404) {
    throw new DriveApiError(404, "Drive can't access that file. Pick it again using the connected Google account.", "not_found");
  }
  if (res.status === 403) throw new DriveApiError(403, DRIVE_ERROR_MESSAGES.permission, "permission");
  if (!res.ok) throw new DriveApiError(res.status, `Unable to read file metadata from Drive (${res.status}).`);
  return res.json();
}

/** Lists the direct video children of a folder (one level — matches "pick a
 *  folder → one video per file" from Phase 14, no recursive sub-folders). */
export async function listFolderVideoFiles(accessToken: string, folderId: string): Promise<DriveFileMeta[]> {
  return listFolderFiles(accessToken, folderId, "mimeType contains 'video/'");
}

/** True when the app can see at least one direct child of the folder (of any type).
 *  With the narrow drive.file scope a picked folder's children are NOT automatically
 *  visible, so "zero children" means "ask the user to pick the files" rather than "empty". */
export async function folderHasVisibleChildren(accessToken: string, folderId: string): Promise<boolean> {
  assertDriveId(folderId);
  const q = encodeURIComponent(`'${folderId}' in parents and trashed = false`);
  const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id)&pageSize=1&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (res.status === 401) throw new DriveApiError(401, "Google Drive rejected the access token.");
  // Only 403/404 mean "this app cannot see the folder's contents". A transient 5xx or 429
  // must NOT look like that, or it would wrongly trigger the Picker fallback.
  if (res.status === 403 || res.status === 404) return false;
  if (!res.ok) throw new DriveApiError(res.status, `Unable to check the Drive folder's contents (${res.status}).`);
  const data = await res.json();
  return Array.isArray(data.files) && data.files.length > 0;
}

export async function listFolderDocumentFiles(accessToken: string, folderId: string): Promise<DriveFileMeta[]> {
  const mimeQuery = SUPPORTED_DOCUMENT_MIME_TYPES.map((m) => `mimeType = '${m}'`).join(" or ");
  return listFolderFiles(accessToken, folderId, `(${mimeQuery})`);
}

async function listFolderFiles(accessToken: string, folderId: string, mimeClause: string): Promise<DriveFileMeta[]> {
  assertDriveId(folderId);
  const files: DriveFileMeta[] = [];
  let pageToken: string | undefined;
  do {
    const q = encodeURIComponent(`'${folderId}' in parents and trashed = false and ${mimeClause}`);
    const url = `${DRIVE_API}/files?q=${q}&fields=nextPageToken,files(${FILE_FIELDS})&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true${pageToken ? `&pageToken=${pageToken}` : ""}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
    if (!res.ok) throw new DriveApiError(res.status, `Unable to list the Drive folder's contents (${res.status}).`);
    const data = await res.json();
    files.push(...(data.files || []));
    pageToken = data.nextPageToken;
  } while (pageToken);
  return files;
}

/** Streams a file's raw bytes from Drive, forwarding a Range header both
 *  ways so the caller (the secure playback/download proxy) can support
 *  seeking and resumable downloads. Returns the raw fetch Response — the
 *  caller pipes .body straight through rather than buffering it. */
export async function fetchFileContent(accessToken: string, fileId: string, range?: string | null, signal?: AbortSignal): Promise<Response> {
  assertDriveId(fileId);
  const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
  if (range) headers.Range = range;
  // no-store: Next's fetch data cache cannot hold bodies over 2 MB and would log an error for every large file.
  // `signal` lets the caller stop the Drive download when the browser disconnects (tab closed, video seek).
  return fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`, { headers, cache: "no-store", signal });
}

/** Proxies a Drive-hosted thumbnail (thumbnailLink requires the same OAuth
 *  session that owns the file — it isn't a public URL). */
export async function fetchThumbnail(accessToken: string, thumbnailLink: string): Promise<Response> {
  return fetch(thumbnailLink, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
}

/** Finds (or creates) a top-level "Study Lamp Backups" folder in the
 *  connected Drive account. Looked up by name each time rather than cached,
 *  since it's one cheap extra call and avoids ever creating a duplicate. */
export async function getOrCreateBackupFolder(accessToken: string): Promise<string> {
  const q = encodeURIComponent(
    "name = 'Study Lamp Backups' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents"
  );
  const res = await fetch(`${DRIVE_API}/files?q=${q}&fields=files(id,name)`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (res.status === 401) throw new DriveApiError(401, "Google Drive rejected the access token.");
  if (res.ok) {
    const data = await res.json();
    if (data.files?.[0]?.id) {
      assertDriveId(data.files[0].id);
      return data.files[0].id;
    }
  }
  const createRes = await fetch(`${DRIVE_API}/files`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Study Lamp Backups", mimeType: "application/vnd.google-apps.folder" }),
  });
  if (!createRes.ok) throw new DriveApiError(createRes.status, "Unable to create the Study Lamp Backups folder in Drive.");
  const created = await createRes.json();
  assertDriveId(created.id);
  return created.id;
}

export async function listBackupFiles(accessToken: string, folderId: string): Promise<DriveFileMeta[]> {
  return listFolderFiles(accessToken, folderId, "mimeType = 'application/json'");
}

/** Uploads a small JSON payload as a new file (single-request "multipart"
 *  upload — fine for backups, which are plain JSON text well under Drive's
 *  5MB simple-upload-friendly size in nearly every real account). */
export async function uploadJsonFile(accessToken: string, folderId: string, name: string, json: unknown): Promise<DriveFileMeta> {
  assertDriveId(folderId);
  const boundary = `slboundary${crypto.randomBytes(8).toString("hex")}`;
  const metadata = JSON.stringify({ name, parents: [folderId], mimeType: "application/json" });
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(json)}\r\n` +
    `--${boundary}--`;

  const res = await fetch(`${DRIVE_UPLOAD_API}?uploadType=multipart&fields=${FILE_FIELDS}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) throw new DriveApiError(res.status, `Unable to upload backup to Drive (${res.status}).`);
  return res.json();
}

export async function downloadJsonFile(accessToken: string, fileId: string): Promise<unknown> {
  const res = await fetchFileContent(accessToken, fileId, null);
  if (!res.ok) throw new DriveApiError(res.status, `Unable to download backup from Drive (${res.status}).`);
  return res.json();
}

/** Starts a resumable upload session (Phase 15). Returns the session URI the
 *  browser then PUTs the file bytes to directly — per Google's own docs,
 *  "the session URI can be used without further authorization for the
 *  duration of the session," so this is the only step that needs our
 *  server-held access token. The heavy upload itself never touches our
 *  server (avoids platform body-size/time limits for large videos). */
export async function startResumableUpload(
  accessToken: string,
  input: { name: string; mimeType: string; folderId?: string | null; sizeBytes: number }
): Promise<string> {
  if (input.folderId) assertDriveId(input.folderId);
  if (!isSupportedUploadMimeType(input.mimeType) || !Number.isInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > MAX_UPLOAD_BYTES) {
    throw new Error("Invalid upload type or size.");
  }
  const name = sanitizeDriveFileName(input.name);
  if (!name) throw new Error("Invalid upload filename.");
  const res = await fetch(`${DRIVE_UPLOAD_API}?uploadType=resumable`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": input.mimeType,
      "X-Upload-Content-Length": String(input.sizeBytes),
    },
    body: JSON.stringify({ name, ...(input.folderId ? { parents: [input.folderId] } : {}) }),
  });
  if (!res.ok) throw new DriveApiError(res.status, `Unable to start a Drive upload session (${res.status}).`);
  const location = res.headers.get("Location") || res.headers.get("location");
  if (!location) throw new Error("Drive did not return an upload session URL.");
  return location;
}

export const SUPPORTED_VIDEO_MIME_PREFIX = "video/";

export const NATIVE_GOOGLE_DOCUMENT_MIME_TYPES = [
  "application/vnd.google-apps.document",
  "application/vnd.google-apps.spreadsheet",
] as const;

export const SUPPORTED_DOCUMENT_MIME_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document", // .docx
  "application/vnd.openxmlformats-officedocument.presentationml.presentation", // .pptx
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
  ...NATIVE_GOOGLE_DOCUMENT_MIME_TYPES,
];

// Single source of truth lives in the pure, shared module (B24).
export { nativeExportMime };

export function documentFileTypeFromMime(mimeType: string): "pdf" | "docx" | "pptx" | "xlsx" | null {
  if (mimeType === "application/pdf") return "pdf";
  if (mimeType === "application/vnd.google-apps.document") return "docx";
  if (mimeType === "application/vnd.google-apps.spreadsheet") return "xlsx";
  if (mimeType.includes("wordprocessingml")) return "docx";
  if (mimeType.includes("presentationml")) return "pptx";
  if (mimeType.includes("spreadsheetml")) return "xlsx";
  return null;
}

export async function exportFile(accessToken: string, fileId: string, exportMime: string): Promise<Response> {
  assertDriveId(fileId);
  const allowedMime = new Set([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ]);
  if (!allowedMime.has(exportMime)) {
    throw new Error("Unsupported Google export MIME type.");
  }
  const res = await fetch(`${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=${encodeURIComponent(exportMime)}&supportsAllDrives=true`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
  });
  if (!res.ok) {
    // Only the machine-readable reason is read from Google's body; the body itself is never kept or logged.
    const reason = extractGoogleErrorReason(await res.json().catch(() => null));
    const code = classifyDriveExportError(res.status, reason);
    throw new DriveApiError(res.status, DRIVE_ERROR_MESSAGES[code], code);
  }
  return res;
}

export async function fetchDocumentBytes(
  accessToken: string,
  input: { driveFileId: string; mimeType: string; googleNative?: boolean },
): Promise<Response> {
  if (input.googleNative) {
    const exportMime = nativeExportMime(input.mimeType);
    if (!exportMime) throw new Error(`Unsupported Google native file type: ${input.mimeType}`);
    return exportFile(accessToken, input.driveFileId, exportMime);
  }
  return fetchFileContent(accessToken, input.driveFileId, null);
}
