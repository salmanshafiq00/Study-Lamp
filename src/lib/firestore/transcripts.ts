import { deleteDoc, doc, getDoc } from "@/lib/firestore/instrumented";
import { discardStoredBlob, persistText, resolveStoredText, type ResolveOptions } from "@/lib/firestore/largeText";
import { planTextStorage } from "@/lib/firestore/inlineLimit";
import { db } from "@/lib/firebase";
import type { VideoTranscript } from "@/types";

/**
 * Manually pasted/uploaded transcripts (Phase 4 — universal transcript
 * input). Same per-user, per-video shape as notes/summaries
 * (src/lib/firestore/notes.ts) — stored at users/{uid}/transcripts/{videoId}
 * so it works uniformly whether videoId belongs to a shared playlist video
 * or a personal video (personal video pages namespace videoId with the
 * "p_" prefix the same way they already do for notes/summaries — see
 * noteKey() in src/app/playlists/[playlistId]/[videoId]/page.tsx).
 *
 * This is only ever a fallback source (see resolveTranscript in
 * src/lib/ai/universalTranscript.ts) for videos with no official
 * captions — YouTube videos keep using the transcript API directly and
 * never need this.
 */
export async function getTranscript(uid: string, videoId: string, options?: ResolveOptions): Promise<VideoTranscript | null> {
  const snap = await getDoc(doc(db, "users", uid, "transcripts", videoId));
  if (!snap.exists()) return null;
  const data = snap.data() as VideoTranscript;
  const { text, truncated } = await resolveStoredText(uid, data, options);
  return truncated ? { ...data, content: text, truncated: true } : { ...data, content: text };
}

/** Over 20 KB the transcript goes to the Drive blob store (roadmap P5); Firestore keeps a pointer and a preview. */
export async function saveTranscript(uid: string, videoId: string, content: string) {
  const trimmed = (content || "").trim();
  if (!trimmed) {
    await deleteTranscript(uid, videoId);
    return;
  }
  await persistText({
    uid, collection: "transcripts", docId: videoId, kind: "transcript", text: trimmed,
    plan: planTextStorage("transcript", videoId, trimmed), fields: { videoId },
  });
}

export async function deleteTranscript(uid: string, videoId: string) {
  const ref = doc(db, "users", uid, "transcripts", videoId);
  const snap = await getDoc(ref).catch(() => null);
  await deleteDoc(ref);
  if (snap?.exists()) discardStoredBlob(uid, snap.data());
}
