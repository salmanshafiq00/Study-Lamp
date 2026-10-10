import { auth } from "@/lib/firebase";
export { toBatches } from "@/lib/batches";

export type CleanupActionId = "quiz_attempts" | "learning_events" | "thumbnails" | "used_tokens" | "sync_log";
export interface StorageCount { id: string; label: string; count: number }
export interface MigrationScan { fields: Array<{ collection: string; id: string }>; contentDocumentIds: string[]; annotationDocumentIds: string[] }

async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) throw new Error("Please sign in again.");
  const response = await fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!response.ok) throw new Error(data.code === "no_drive" ? "Connect Google Drive first (Settings → Google Drive)." : data.error || "Request failed.");
  return data;
}

export const loadStorageHealth = () => call<{ counts: StorageCount[]; note: string }>("GET", "/api/storage/health");
export const previewCleanupRequest = (action: CleanupActionId, months?: number) => call<{ count: number }>("POST", "/api/storage/cleanup/preview", { action, months });
export const runCleanupRequest = (action: CleanupActionId, months?: number) => call<{ deleted: number; remaining: number }>("POST", "/api/storage/cleanup", { action, months, confirm: true });

export async function scanMigrations(): Promise<MigrationScan> {
  const [text, annotations] = await Promise.all([
    call<{ fields: MigrationScan["fields"]; contentDocumentIds: string[] }>("GET", "/api/blobs/migrate-text"),
    call<{ documentIds: string[] }>("GET", "/api/blobs/migrate-annotations"),
  ]);
  return { fields: text.fields, contentDocumentIds: text.contentDocumentIds, annotationDocumentIds: annotations.documentIds };
}
export const migrateTextBatch = (fields: MigrationScan["fields"], contentDocumentIds: string[]) =>
  call<{ moved: number; failed: number }>("POST", "/api/blobs/migrate-text", { fields, contentDocumentIds });
export const migrateAnnotationBatch = (documentIds: string[]) => call<{ moved: number; failed: number }>("POST", "/api/blobs/migrate-annotations", { documentIds });
