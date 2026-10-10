import { hashText } from "@/lib/server/docTextCache";
import { INLINE_LIMIT_BYTES, utf8Bytes, previewOf, type LargeTextKind } from "@/lib/firestore/inlineLimit";

export type LargeMigrationStatus = "moved" | "skipped" | "failed";
export const LARGE_MIGRATION_BATCH = 5;

export type TextCollection = "notes" | "summaries" | "transcripts";
export const COLLECTION_KIND: Record<TextCollection, LargeTextKind> = { notes: "note", summaries: "summary", transcripts: "transcript" };

/** Candidates are docs whose inline `content` is over the 20 KB limit and that have no pointer yet. Pure. */
export function isOversizedInline(data: Record<string, unknown> | undefined): boolean {
  return !!data && typeof data.content === "string" && !data.blobKind && utf8Bytes(data.content) > INLINE_LIMIT_BYTES;
}

export interface FieldMigrationDeps {
  readInline(): Promise<string | null>;
  putBlob(jsonText: string): Promise<void>;
  readBack(): Promise<string | null>;
  /** Replaces inline content by the pointer + preview. Called only after the read-back hash matched. */
  writePointer(pointer: { blobKind: LargeTextKind; blobKey: string; bytes: number; preview: string }): Promise<void>;
}

/** Moves ONE oversized field to the blob store; the Firestore copy is replaced only after the blob read back identically. */
export async function migrateOneField(deps: FieldMigrationDeps, kind: LargeTextKind, key: string): Promise<LargeMigrationStatus> {
  try {
    const text = await deps.readInline();
    if (text === null || utf8Bytes(text) <= INLINE_LIMIT_BYTES) return "skipped";
    await deps.putBlob(JSON.stringify({ text }));
    const back = await deps.readBack();
    if (back === null) return "failed";
    const parsed = JSON.parse(back) as { text?: unknown };
    if (typeof parsed.text !== "string" || hashText(parsed.text) !== hashText(text)) return "failed";
    await deps.writePointer({ blobKind: kind, blobKey: key, bytes: utf8Bytes(text), preview: previewOf(text) });
    return "moved";
  } catch {
    return "failed";
  }
}

export interface ContentMigrationDeps {
  readLegacyText(): Promise<{ text: string; revision: { md5Checksum: string | null; modifiedTime: string | null }; textHash: string } | null>;
  putBlob(jsonText: string): Promise<void>;
  readBack(): Promise<string | null>;
  deleteLegacy(): Promise<void>;
}

/** Moves ONE document's legacy content/* text to the "doctext" blob; deletes the chunks only after the hash matched. */
export async function migrateOneContent(deps: ContentMigrationDeps): Promise<LargeMigrationStatus> {
  try {
    const legacy = await deps.readLegacyText();
    if (!legacy) return "skipped";
    if (hashText(legacy.text) !== legacy.textHash) return "failed"; // corrupt legacy copy: leave it, it will be re-extracted
    await deps.putBlob(JSON.stringify({ revision: legacy.revision, textHash: legacy.textHash, text: legacy.text }));
    const back = await deps.readBack();
    if (back === null) return "failed";
    const parsed = JSON.parse(back) as { text?: unknown };
    if (typeof parsed.text !== "string" || hashText(parsed.text) !== legacy.textHash) return "failed";
    await deps.deleteLegacy();
    return "moved";
  } catch {
    return "failed";
  }
}
