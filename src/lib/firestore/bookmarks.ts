import { addDoc, collection, deleteDoc, doc, getDocs, limit, orderBy, query, serverTimestamp } from "@/lib/firestore/instrumented";
import { db } from "@/lib/firebase";
import type { Bookmark } from "@/types";

const bookmarksCol = (uid: string, videoId: string) => collection(db, "users", uid, "bookmarks", videoId, "items");

export async function listBookmarks(uid: string, videoId: string): Promise<Bookmark[]> {
  const q = query(bookmarksCol(uid, videoId), orderBy("timestampSeconds", "asc"), limit(100));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }) as Bookmark);
}

export async function addBookmark(uid: string, videoId: string, timestampSeconds: number, label: string) {
  await addDoc(bookmarksCol(uid, videoId), { videoId, timestampSeconds, label, createdAt: serverTimestamp() });
}

export async function removeBookmark(uid: string, videoId: string, bookmarkId: string) {
  await deleteDoc(doc(db, "users", uid, "bookmarks", videoId, "items", bookmarkId));
}
