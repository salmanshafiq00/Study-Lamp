import { deleteDoc, deleteField, doc, getDoc, serverTimestamp, setDoc } from "@/lib/firestore/instrumented";
import { discardStoredBlob, persistText, resolveStoredText, type ResolveOptions } from "@/lib/firestore/largeText";
import { planTextStorage } from "@/lib/firestore/inlineLimit";
import { db } from "@/lib/firebase";
import { normalizeNoteContent } from "@/lib/noteUtils";
import { needsMigration, normalizeSummaryContent } from "@/lib/richText";
import type { VideoNote, VideoSummary } from "@/types";

export async function getNote(uid: string, videoId: string, options?: ResolveOptions): Promise<VideoNote | null> {
  const snap = await getDoc(doc(db, "users", uid, "notes", videoId));
  if (!snap.exists()) return null;
  const data = snap.data() as VideoNote;
  const { text, truncated } = await resolveStoredText(uid, data, options);
  return truncated ? { ...data, content: text, truncated: true } : { ...data, content: text };
}

export async function saveNote(uid: string, videoId: string, content: string, pageNumber?: number | null) {
  const normalized = normalizeNoteContent(content);
  if (!normalized) {
    await deleteNote(uid, videoId);
    return;
  }

  const pageField = pageNumber === undefined ? {} : pageNumber === null ? { pageNumber: deleteField() } : { pageNumber };
  await persistText({
    uid, collection: "notes", docId: videoId, kind: "note", text: normalized,
    plan: planTextStorage("note", videoId, normalized),
    fields: { videoId, ...pageField },
  });
}

export async function deleteNote(uid: string, videoId: string) {
  const ref = doc(db, "users", uid, "notes", videoId);
  const snap = await getDoc(ref).catch(() => null);
  await deleteDoc(ref);
  if (snap?.exists()) discardStoredBlob(uid, snap.data());
}

export async function getSummary(uid: string, videoId: string, options?: ResolveOptions): Promise<VideoSummary | null> {
  const snap = await getDoc(doc(db, "users", uid, "summaries", videoId));
  if (!snap.exists()) return null;

  const data = snap.data() as VideoSummary & { blobKind?: unknown };
  const hasPointer = typeof data.blobKind === "string";
  const { text: stored, truncated } = await resolveStoredText(uid, data, options);

  // Lazy one-time migration of legacy markdown/plain-text summaries to the canonical HTML format
  // (see src/lib/richText.ts). Inline summaries only: a Drive-backed summary was already saved as HTML,
  // and reading an up-to-date summary causes no write at all.
  if (!hasPointer && needsMigration(stored)) {
    const migrated = normalizeSummaryContent(stored);
    // Fire-and-forget: the read must not fail or slow down because the upgrade write did.
    void persistText({
      uid, collection: "summaries", docId: videoId, kind: "summary", text: migrated,
      plan: planTextStorage("summary", videoId, migrated), fields: { videoId },
    }).catch(() => {});
    return { ...data, content: migrated };
  }

  return truncated ? { ...data, content: stored, truncated: true } : { ...data, content: stored };
}

/**
 * Persists a summary.
 *
 * Content is normalized to canonical HTML before storing, so every caller can hand over whatever it has
 * (editor output, AI-generated text, a markdown paste). Over 20 KB it goes to the Drive blob store (roadmap P5).
 */
export async function saveSummary(uid: string, videoId: string, content: string) {
  const normalized = normalizeSummaryContent(content);
  await persistText({
    uid, collection: "summaries", docId: videoId, kind: "summary", text: normalized,
    plan: planTextStorage("summary", videoId, normalized), fields: { videoId },
  });
}
