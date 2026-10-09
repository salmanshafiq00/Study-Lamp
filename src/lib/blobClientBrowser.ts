import { auth } from "@/lib/firebase";
import { createBlobClient, createIndexedDbBlobStore, type BlobClient, type RemoteResponse } from "@/lib/blobClient";

let client: BlobClient | null = null;
let clientUid: string | null = null;

async function request(method: "GET" | "PUT" | "DELETE", kind: string, key: string, body?: string): Promise<RemoteResponse> {
  const token = await auth.currentUser?.getIdToken();
  if (!token) return { status: 401, body: {} };
  const response = await fetch(`/api/blobs/${kind}/${key}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body,
  });
  let parsed: unknown = {};
  try { parsed = await response.json(); } catch { /* empty body */ }
  return { status: response.status, body: parsed };
}

/** Per-user singleton (IndexedDB "study-lamp-blobs"). A different signed-in user gets a fresh client. */
export function getBlobClient(uid: string): BlobClient {
  if (!client || clientUid !== uid) {
    client = createBlobClient({ uid, local: createIndexedDbBlobStore(), request });
    clientUid = uid;
    if (typeof window !== "undefined") {
      window.addEventListener("pagehide", () => { void client?.flushAll(); });
      window.document.addEventListener("visibilitychange", () => { if (window.document.visibilityState === "hidden") void client?.flushAll(); });
    }
  }
  return client;
}

/** Call on sign-out: drops every local blob copy. */
export async function clearLocalBlobs(): Promise<void> {
  const active = client;
  client = null; clientUid = null;
  if (active) await active.clearLocal();
  else await createIndexedDbBlobStore().clearAll();
}
