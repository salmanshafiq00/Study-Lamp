import { deleteDoc, doc, getDoc, serverTimestamp, setDoc } from "@/lib/firestore/instrumented";
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
export async function getTranscript(uid: string, videoId: string): Promise<VideoTranscript | null> {
  const snap = await getDoc(doc(db, "users", uid, "transcripts", videoId));
  return snap.exists() ? (snap.data() as VideoTranscript) : null;
}

export async function saveTranscript(uid: string, videoId: string, content: string) {
  const trimmed = (content || "").trim();
  if (!trimmed) {
    await deleteTranscript(uid, videoId);
    return;
  }
  await setDoc(
    doc(db, "users", uid, "transcripts", videoId),
    { videoId, content: trimmed, updatedAt: serverTimestamp() },
    { merge: true }
  );
}

export async function deleteTranscript(uid: string, videoId: string) {
  await deleteDoc(doc(db, "users", uid, "transcripts", videoId));
}
