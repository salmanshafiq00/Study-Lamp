import { deleteField, doc, setDoc, serverTimestamp } from "@/lib/firestore/instrumented";
import { db } from "@/lib/firebase";
import { toast } from "sonner";
import { getBlobClient, deleteRemoteBlob } from "@/lib/blobClientBrowser";
import { fitsInlineFallback, pointerOf, type LargeTextKind, type StoredTextDoc, type TextStoragePlan } from "@/lib/firestore/inlineLimit";

/** Thrown when a pointer exists but its Drive text cannot be read (offline, disconnected, trashed). Never silently shows a preview. */
export class LargeTextUnavailableError extends Error {
  constructor() {
    super("Couldn't load this saved text from Google Drive. Check your connection or reconnect Google Drive.");
    this.name = "LargeTextUnavailableError";
  }
}

/** Keys known (this session) to have a Drive blob, so an inline save can clean it up without an extra read. */
const knownBlobs = new Set<string>();
const idOf = (uid: string, kind: LargeTextKind, key: string) => `${uid}:${kind}:${key}`;

export interface ResolveOptions {
  /** Used for another user's data (admin view, shared playlist): their Drive blob is not readable, so return the preview. */
  allowPreview?: boolean;
}

/** Full text for a stored document: inline `content`, or the Drive blob its pointer names. */
export async function resolveStoredText(uid: string, data: StoredTextDoc, options: ResolveOptions = {}): Promise<{ text: string; truncated: boolean }> {
  const inline = typeof data.content === "string" ? data.content : "";
  const pointer = pointerOf(data);
  if (!pointer) return { text: inline, truncated: false };
  knownBlobs.add(idOf(uid, pointer.kind, pointer.key));
  const result = await getBlobClient(uid).readThrough(pointer.kind, pointer.key);
  const json = result.json as { text?: unknown } | null;
  if ((result.source === "local" || result.source === "remote") && json && typeof json.text === "string") {
    return { text: json.text, truncated: false };
  }
  if (options.allowPreview) return { text: inline, truncated: true };
  throw new LargeTextUnavailableError();
}

interface WriteInput {
  uid: string;
  collection: "notes" | "summaries" | "transcripts";
  docId: string;
  kind: LargeTextKind;
  /** Extra fields to merge into the Firestore document (videoId, pageNumber...). */
  fields: Record<string, unknown>;
  text: string;
  plan: TextStoragePlan;
}

/**
 * Persists text per its storage plan. Inline: one Firestore write (pointer fields removed). Blob: one small Firestore
 * pointer write now, the text goes to Drive through the debounced blob client; if Drive refuses (not connected, quota)
 * and the text fits the rules cap, it is written inline instead; otherwise the user is told and the local copy is kept.
 */
export async function persistText({ uid, collection, docId, kind, fields, text, plan }: WriteInput): Promise<void> {
  const ref = doc(db, "users", uid, collection, docId);
  const id = idOf(uid, kind, docId);

  if (plan.mode === "inline") {
    await setDoc(ref, { ...fields, content: plan.content, blobKind: deleteField(), blobKey: deleteField(), bytes: deleteField(), preview: deleteField(), updatedAt: serverTimestamp() }, { merge: true });
    if (knownBlobs.delete(id)) void deleteRemoteBlob(kind, docId);
    return;
  }

  await setDoc(ref, { ...fields, content: plan.content, ...plan.pointer, updatedAt: serverTimestamp() }, { merge: true });
  knownBlobs.add(id);
  await getBlobClient(uid).write(kind, docId, { text }, async () => {
    if (!fitsInlineFallback(text)) {
      toast.error("This text is too large to save without Google Drive. Reconnect Google Drive in Settings to keep it.");
      return false;
    }
    await setDoc(ref, { ...fields, content: text, blobKind: deleteField(), blobKey: deleteField(), bytes: deleteField(), preview: deleteField(), updatedAt: serverTimestamp() }, { merge: true });
    knownBlobs.delete(id);
    return true;
  });
}

/** Removes a pointer's blob (used when the text is deleted). */
export function discardStoredBlob(uid: string, data: StoredTextDoc | null | undefined): void {
  const pointer = pointerOf(data);
  if (!pointer) return;
  knownBlobs.delete(idOf(uid, pointer.kind, pointer.key));
  void deleteRemoteBlob(pointer.kind, pointer.key);
}
