/**
 * Drive blob store (roadmap P4, decision D15). Study Lamp's OWN storage files live in a "Study Lamp data" folder
 * created with the narrow drive.file scope; Firestore keeps only a pointer (users/{uid}/blobs/{kind}__{key}).
 * Everything here is pure orchestration over injected deps (DriveBlobApi + BlobPointerStore) so it is unit-tested
 * with fakes. assertBlobWriteAllowed is the ONLY gate that lets these writes skip the preview dialog.
 */
export const BLOB_KINDS = ["annotations", "doctext", "transcript", "backup"] as const;
export type BlobKind = (typeof BLOB_KINDS)[number];

export const BLOB_KEY_PATTERN = /^[A-Za-z0-9_-]{1,80}$/;
export const BLOB_NAME_PATTERN = /^(annotations|doctext|transcript|backup)-[A-Za-z0-9_-]{1,80}\.json$/;
export const BLOB_FOLDER_NAME = "Study Lamp data";
export const BLOB_MAX_BYTES: Record<BlobKind, number> = {
  annotations: 2 * 1024 * 1024,
  doctext: 5 * 1024 * 1024,
  transcript: 5 * 1024 * 1024,
  backup: 5 * 1024 * 1024,
};

export type BlobErrorCode =
  | "invalid" | "forbidden" | "too_large" | "auth" | "scope_missing" | "quota" | "not_found" | "no_connection" | "upstream";

export class BlobStoreError extends Error {
  /** Upstream HTTP status for "auth" (401) so runWithDriveToken can refresh the token and retry once. */
  readonly status?: number;
  constructor(readonly code: BlobErrorCode, status?: number) {
    super(`blob store: ${code}`);
    this.name = "BlobStoreError";
    this.status = status;
  }
}

export function isBlobKind(value: unknown): value is BlobKind {
  return typeof value === "string" && (BLOB_KINDS as readonly string[]).includes(value);
}
export function isBlobKey(value: unknown): value is string {
  return typeof value === "string" && BLOB_KEY_PATTERN.test(value);
}
export function blobFileName(kind: BlobKind, key: string): string {
  return `${kind}-${key}.json`;
}
export function blobPointerId(kind: BlobKind, key: string): string {
  return `${kind}__${key}`;
}

export interface BlobPointer { fileId: string; bytes: number; version: string | null; connectionId: string; updatedAt: number }

export interface DriveBlobApi {
  getFolder(folderId: string): Promise<{ id: string; trashed: boolean } | null>;
  findFolder(name: string): Promise<string | null>;
  createFolder(name: string): Promise<string>;
  createFile(input: { name: string; parentId: string; json: string }): Promise<{ id: string; version: string | null }>;
  /** Returns trashed=true when the file sits in the Drive trash (the caller then creates a fresh file). Null = gone. */
  updateFile(fileId: string, json: string): Promise<{ id: string; version: string | null; trashed: boolean } | null>;
  getFileMeta(fileId: string): Promise<{ trashed: boolean; version: string | null } | null>;
  getFileContent(fileId: string): Promise<string | null>;
  trashFile(fileId: string): Promise<void>;
}

export interface BlobPointerStore {
  getFolderId(uid: string, connectionId: string): Promise<string | null>;
  setFolderId(uid: string, connectionId: string, folderId: string): Promise<void>;
  getPointer(uid: string, kind: BlobKind, key: string): Promise<BlobPointer | null>;
  setPointer(uid: string, kind: BlobKind, key: string, pointer: BlobPointer): Promise<void>;
  deletePointer(uid: string, kind: BlobKind, key: string): Promise<void>;
}

/** D15 gate: fixed parent folder, fixed file-name pattern, size cap. Anything else throws "forbidden". */
export function assertBlobWriteAllowed(input: { parentId: string; folderId: string; name: string; bytes: number; kind: BlobKind }): void {
  if (!input.folderId || input.parentId !== input.folderId) throw new BlobStoreError("forbidden");
  if (!BLOB_NAME_PATTERN.test(input.name) || !input.name.startsWith(`${input.kind}-`)) throw new BlobStoreError("forbidden");
  if (!Number.isFinite(input.bytes) || input.bytes < 0) throw new BlobStoreError("invalid");
  if (input.bytes > BLOB_MAX_BYTES[input.kind]) throw new BlobStoreError("too_large");
}

export interface BlobStoreDeps { api: DriveBlobApi; pointers: BlobPointerStore; now?: () => number }

/** Verified app folder id; recreated when the stored one is missing or trashed. */
export async function ensureAppFolder(deps: BlobStoreDeps, uid: string, connectionId: string): Promise<string> {
  const stored = await deps.pointers.getFolderId(uid, connectionId);
  if (stored) {
    const folder = await deps.api.getFolder(stored);
    if (folder && !folder.trashed) return stored;
  }
  const found = await deps.api.findFolder(BLOB_FOLDER_NAME);
  const folderId = found ?? (await deps.api.createFolder(BLOB_FOLDER_NAME));
  await deps.pointers.setFolderId(uid, connectionId, folderId);
  return folderId;
}

export async function putBlob(
  deps: BlobStoreDeps,
  input: { uid: string; connectionId: string; kind: BlobKind; key: string; jsonText: string },
): Promise<{ bytes: number; version: string | null }> {
  if (!isBlobKind(input.kind) || !isBlobKey(input.key)) throw new BlobStoreError("invalid");
  const bytes = Buffer.byteLength(input.jsonText, "utf8");
  if (bytes > BLOB_MAX_BYTES[input.kind]) throw new BlobStoreError("too_large");

  const folderId = await ensureAppFolder(deps, input.uid, input.connectionId);
  const name = blobFileName(input.kind, input.key);
  assertBlobWriteAllowed({ parentId: folderId, folderId, name, bytes, kind: input.kind });

  const pointer = await deps.pointers.getPointer(input.uid, input.kind, input.key);
  let saved: { id: string; version: string | null } | null = null;
  if (pointer) {
    const updated = await deps.api.updateFile(pointer.fileId, input.jsonText);
    if (updated && !updated.trashed) saved = updated;
  }
  if (!saved) saved = await deps.api.createFile({ name, parentId: folderId, json: input.jsonText });

  await deps.pointers.setPointer(input.uid, input.kind, input.key, {
    fileId: saved.id, bytes, version: saved.version, connectionId: input.connectionId, updatedAt: (deps.now ?? Date.now)(),
  });
  return { bytes, version: saved.version };
}

/** Null when there is no pointer, the file was trashed/deleted in Drive, or the content is not valid JSON. */
export async function getBlob(
  deps: BlobStoreDeps,
  input: { uid: string; kind: BlobKind; key: string },
): Promise<{ json: unknown; version: string | null; connectionId: string } | null> {
  if (!isBlobKind(input.kind) || !isBlobKey(input.key)) throw new BlobStoreError("invalid");
  const pointer = await deps.pointers.getPointer(input.uid, input.kind, input.key);
  if (!pointer) return null;
  const meta = await deps.api.getFileMeta(pointer.fileId);
  if (!meta || meta.trashed) { await deps.pointers.deletePointer(input.uid, input.kind, input.key); return null; }
  const text = await deps.api.getFileContent(pointer.fileId);
  if (text === null) { await deps.pointers.deletePointer(input.uid, input.kind, input.key); return null; }
  try {
    return { json: JSON.parse(text), version: meta.version, connectionId: pointer.connectionId };
  } catch {
    return null; // the user edited the file in Drive and broke it: treat as empty, the next save rewrites it
  }
}

/** Trashes the Drive file (never a hard delete) and removes the pointer. */
export async function deleteBlob(deps: BlobStoreDeps, input: { uid: string; kind: BlobKind; key: string }): Promise<boolean> {
  if (!isBlobKind(input.kind) || !isBlobKey(input.key)) throw new BlobStoreError("invalid");
  const pointer = await deps.pointers.getPointer(input.uid, input.kind, input.key);
  if (!pointer) return false;
  await deps.api.trashFile(pointer.fileId);
  await deps.pointers.deletePointer(input.uid, input.kind, input.key);
  return true;
}
