import crypto from "crypto";
import { isSameDriveRevision, type DriveRevision } from "@/lib/server/documentContentUtils";

/**
 * P5: extracted document text lives in the Drive blob store (kind "doctext", key = documentId) instead of Firestore
 * chunk documents. The blob holds { revision, textHash, text }; it is valid only while Drive's content revision is
 * unchanged. Pure orchestration over injected deps, so it is unit-tested with fakes.
 */
export interface DocTextBlob { revision: DriveRevision; textHash: string; text: string }

export const hashText = (text: string) => crypto.createHash("sha256").update(text).digest("hex");

export function parseDocTextBlob(json: unknown): DocTextBlob | null {
  if (!json || typeof json !== "object") return null;
  const { revision, textHash, text } = json as Record<string, unknown>;
  if (typeof text !== "string" || typeof textHash !== "string" || !revision || typeof revision !== "object") return null;
  const rev = revision as Record<string, unknown>;
  return {
    revision: {
      md5Checksum: typeof rev.md5Checksum === "string" ? rev.md5Checksum : null,
      modifiedTime: typeof rev.modifiedTime === "string" ? rev.modifiedTime : null,
    },
    textHash,
    text,
  };
}

/** A blob is usable only when the revision matches and the text still hashes to the stored hash. */
export function isValidDocTextBlob(blob: DocTextBlob | null, revision: DriveRevision): blob is DocTextBlob {
  return !!blob && isSameDriveRevision(blob.revision, revision) && hashText(blob.text) === blob.textHash;
}

export interface DocTextDeps {
  readBlob(): Promise<unknown | null>;
  /** Throws on failure. */
  writeBlob(blob: DocTextBlob): Promise<void>;
  /** Text from the pre-P5 Firestore `content/*` documents when they still match this revision, else null. */
  readLegacy(revision: DriveRevision): Promise<string | null>;
  /** Removes the legacy `content/*` documents. Called only after a verified blob exists. */
  deleteLegacy(): Promise<void>;
  /** Downloads and extracts the text (the expensive path). */
  extract(): Promise<string>;
  /** Stores the revision on the document record (only called when it differs from what is stored). */
  recordRevision(revision: DriveRevision): Promise<void>;
}

export interface DocTextResult { text: string; source: "blob" | "legacy" | "extracted"; cached: boolean }

export async function resolveDocumentText(deps: DocTextDeps, revision: DriveRevision): Promise<DocTextResult> {
  let existing: DocTextBlob | null = null;
  try { existing = parseDocTextBlob(await deps.readBlob()); } catch { existing = null; }
  if (isValidDocTextBlob(existing, revision)) return { text: existing.text, source: "blob", cached: true };

  const legacy = await deps.readLegacy(revision).catch(() => null);
  const text = legacy ?? (await deps.extract());
  const source = legacy !== null ? "legacy" : "extracted";

  const blob: DocTextBlob = { revision: { md5Checksum: revision.md5Checksum ?? null, modifiedTime: revision.modifiedTime ?? null }, textHash: hashText(text), text };
  let cached = false;
  try {
    await deps.writeBlob(blob);
    // Verify before touching legacy data: read back and compare hashes.
    const back = parseDocTextBlob(await deps.readBlob());
    cached = isValidDocTextBlob(back, revision) && back.textHash === blob.textHash;
  } catch {
    cached = false; // no Drive / quota / too large: the text is still returned, just not cached
  }
  if (cached) await deps.deleteLegacy().catch(() => undefined);
  if (source === "extracted") await deps.recordRevision(blob.revision).catch(() => undefined);
  return { text, source, cached };
}
