import crypto from "crypto";
import { buildAnnotationsBlob, parseDocumentAnnotations } from "@/lib/documentAnnotations";

export type MigrationStatus = "moved" | "skipped_none" | "skipped_empty" | "failed";

export interface AnnotationMigrationDeps {
  /** Legacy Firestore annotationsJson for the document, or null when there is none. */
  readLegacy(documentId: string): Promise<string | null>;
  putBlob(documentId: string, jsonText: string): Promise<void>;
  /** The JSON text read back from the blob store, or null. */
  readBackBlob(documentId: string): Promise<string | null>;
  deleteLegacy(documentId: string): Promise<void>;
}

const hash = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

/**
 * Moves ONE document's annotations to the blob store. The legacy Firestore document is deleted only after the blob
 * was read back and its hash equals what was written (never before; a mismatch leaves everything untouched).
 */
export async function migrateOneAnnotation(deps: AnnotationMigrationDeps, documentId: string): Promise<MigrationStatus> {
  try {
    const legacyJson = await deps.readLegacy(documentId);
    if (legacyJson === null) return "skipped_none";
    const blob = buildAnnotationsBlob(parseDocumentAnnotations(legacyJson));
    const written = JSON.stringify(blob);
    await deps.putBlob(documentId, written);
    const back = await deps.readBackBlob(documentId);
    if (back === null) return "failed";
    let parsedBack: unknown;
    try { parsedBack = JSON.parse(back); } catch { return "failed"; }
    if (hash(JSON.stringify(parsedBack)) !== hash(written)) return "failed";
    await deps.deleteLegacy(documentId);
    return blob.annotations.length === 0 ? "skipped_empty" : "moved";
  } catch {
    return "failed";
  }
}

export const MIGRATION_BATCH_SIZE = 5;
