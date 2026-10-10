/**
 * Roadmap P5 / D16: a Firestore document stays under 20 KB. Larger user text (summary, note, transcript) is stored
 * as a Drive blob; Firestore keeps a pointer plus a short preview. Pure: no Firebase import, unit-tested.
 */
export const INLINE_LIMIT_BYTES = 20 * 1024;
export const PREVIEW_CHARS = 300;
/** firestore.rules caps notes/summaries/transcripts `content` at 50,000 characters; the inline fallback must fit. */
export const RULES_MAX_CONTENT_CHARS = 50_000;

export type LargeTextKind = "summary" | "note" | "transcript";

export class InlineTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Value is ${bytes} bytes; the inline limit is ${INLINE_LIMIT_BYTES}.`);
    this.name = "InlineTooLargeError";
  }
}

export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function exceedsInline(value: string): boolean {
  return utf8Bytes(value) > INLINE_LIMIT_BYTES;
}

/** Throws InlineTooLargeError when the value is over the limit (callers then store a blob instead). */
export function assertInlineSize(value: string): void {
  const bytes = utf8Bytes(value);
  if (bytes > INLINE_LIMIT_BYTES) throw new InlineTooLargeError(bytes);
}

/** First PREVIEW_CHARS code points; never cuts a surrogate pair in half. */
export function previewOf(text: string): string {
  return Array.from(text.slice(0, PREVIEW_CHARS * 2)).slice(0, PREVIEW_CHARS).join("");
}

export interface PointerFields { blobKind: LargeTextKind; blobKey: string; bytes: number; preview: string }

export type TextStoragePlan =
  | { mode: "inline"; content: string }
  | { mode: "blob"; content: string; pointer: PointerFields };

/** Decides where `text` lives. For "blob" the Firestore `content` is only the preview. */
export function planTextStorage(kind: LargeTextKind, key: string, text: string): TextStoragePlan {
  const bytes = utf8Bytes(text);
  if (bytes <= INLINE_LIMIT_BYTES) return { mode: "inline", content: text };
  const preview = previewOf(text);
  return { mode: "blob", content: preview, pointer: { blobKind: kind, blobKey: key, bytes, preview } };
}

export interface StoredTextDoc { content?: unknown; blobKind?: unknown; blobKey?: unknown }

export function pointerOf(data: StoredTextDoc | undefined | null): { kind: LargeTextKind; key: string } | null {
  if (!data) return null;
  const { blobKind, blobKey } = data;
  if ((blobKind === "summary" || blobKind === "note" || blobKind === "transcript") && typeof blobKey === "string" && blobKey) {
    return { kind: blobKind, key: blobKey };
  }
  return null;
}

/** True when the text may still be written inline after a failed blob save (rules cap + 20 KB-class sanity). */
export function fitsInlineFallback(text: string): boolean {
  return text.length <= RULES_MAX_CONTENT_CHARS;
}
