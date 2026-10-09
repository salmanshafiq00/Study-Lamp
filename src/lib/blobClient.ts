/**
 * Browser-side blob client (roadmap P4). No React, no Firebase import: the real IndexedDB store and the
 * authenticated fetch are injected by blobClientBrowser.ts, so this logic is unit-tested with fakes.
 *  - readThrough: IndexedDB first (instant), then GET /api/blobs/..., then the local copy is updated;
 *  - write: saved to IndexedDB immediately, sent to Drive at most once per `writeIntervalMs` (default 3 s),
 *    retried with exponential backoff; the local copy keeps `dirty: true` until the server confirmed it.
 */
import { createPersister, type Persister } from "@/lib/persistThrottle";

export type BlobKind = "annotations" | "doctext" | "transcript" | "backup";
export type SaveState = "saved" | "saving" | "offline";
export interface SaveStatus { state: SaveState; code?: string }

export interface LocalBlobRecord { id: string; kind: BlobKind; key: string; json: unknown; version: string | null; savedAt: number; dirty: boolean }
export interface LocalBlobStore {
  get(id: string): Promise<LocalBlobRecord | undefined>;
  put(record: LocalBlobRecord): Promise<void>;
  clearAll(): Promise<void>;
}
export interface RemoteResponse { status: number; body: unknown }

export interface BlobClientDeps {
  uid: string;
  local: LocalBlobStore;
  request: (method: "GET" | "PUT" | "DELETE", kind: BlobKind, key: string, body?: string) => Promise<RemoteResponse>;
  now?: () => number;
  writeIntervalMs?: number;
  /** A local copy older than this is re-checked against Drive in the background. */
  staleAfterMs?: number;
}

export type ReadResult =
  | { source: "local" | "remote"; json: unknown }
  | { source: "none"; json: null }
  | { source: "error"; json: null; code: string };

/** Non-retryable server answers: keep the local copy, offer the fallback, stop retrying. */
const FINAL_FAILURE: Record<number, string> = { 409: "reconnect", 413: "too_large", 507: "quota", 400: "invalid", 403: "forbidden", 404: "not_found" };

function codeOf(response: RemoteResponse): string {
  const code = (response.body as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : FINAL_FAILURE[response.status] ?? "error";
}

export function createBlobClient(deps: BlobClientDeps) {
  const now = deps.now ?? Date.now;
  const staleAfterMs = deps.staleAfterMs ?? 10 * 60_000;
  const writeIntervalMs = deps.writeIntervalMs ?? 3000;
  const persisters = new Map<string, Persister<unknown>>();
  const statuses = new Map<string, SaveStatus>();
  const listeners = new Set<(id: string, status: SaveStatus) => void>();
  const fallbacks = new Map<string, (json: unknown, code: string) => Promise<boolean>>();

  const idOf = (kind: BlobKind, key: string) => `${deps.uid}:${kind}:${key}`;
  const setStatus = (id: string, status: SaveStatus) => { statuses.set(id, status); listeners.forEach((listener) => listener(id, status)); };

  async function saveLocal(kind: BlobKind, key: string, json: unknown, version: string | null, dirty: boolean) {
    await deps.local.put({ id: idOf(kind, key), kind, key, json, version, savedAt: now(), dirty });
  }

  function persisterFor(kind: BlobKind, key: string): Persister<unknown> {
    const id = idOf(kind, key);
    let persister = persisters.get(id);
    if (persister) return persister;
    persister = createPersister<unknown>({
      minIntervalMs: writeIntervalMs,
      retryDelayMs: (failures) => Math.min(60_000, writeIntervalMs * 2 ** failures),
      write: async (value) => {
        let response: RemoteResponse;
        try {
          response = await deps.request("PUT", kind, key, JSON.stringify(value));
        } catch {
          setStatus(id, { state: "offline", code: "network" });
          throw new Error("network"); // the persister keeps the value and retries with backoff
        }
        if (response.status >= 200 && response.status < 300) {
          const version = (response.body as { version?: unknown } | null)?.version;
          await saveLocal(kind, key, value, typeof version === "string" ? version : null, false);
          setStatus(id, { state: "saved" });
          return;
        }
        const code = codeOf(response);
        if (response.status in FINAL_FAILURE) {
          const handled = await fallbacks.get(id)?.(value, code).catch(() => false);
          if (handled) { await saveLocal(kind, key, value, null, false); setStatus(id, { state: "saved", code }); }
          else setStatus(id, { state: "offline", code });
          return; // final: do not retry until the next edit
        }
        setStatus(id, { state: "offline", code });
        throw new Error("retry");
      },
    });
    persisters.set(id, persister);
    return persister;
  }

  async function revalidate(kind: BlobKind, key: string, current: LocalBlobRecord, onUpdate?: (json: unknown) => void) {
    try {
      const response = await deps.request("GET", kind, key);
      if (response.status === 200) {
        const remote = (response.body as { json?: unknown; version?: unknown } | null) ?? {};
        const fresh = await deps.local.get(current.id);
        if (fresh?.dirty) return; // the user edited meanwhile: never overwrite unsent work
        const changed = JSON.stringify(remote.json) !== JSON.stringify(current.json);
        await saveLocal(kind, key, remote.json ?? null, typeof remote.version === "string" ? remote.version : null, false);
        if (changed) onUpdate?.(remote.json);
      } else if (response.status === 404) {
        await saveLocal(kind, key, current.json, current.version, false); // still valid: refresh the timestamp only
      }
    } catch { /* offline: keep the local copy */ }
  }

  return {
    async readThrough(kind: BlobKind, key: string, onUpdate?: (json: unknown) => void): Promise<ReadResult> {
      const local = await deps.local.get(idOf(kind, key)).catch(() => undefined);
      if (local) {
        if (local.dirty) void persisterFor(kind, key).update(local.json); // unsent work from a previous session
        else if (now() - local.savedAt > staleAfterMs) void revalidate(kind, key, local, onUpdate);
        return { source: "local", json: local.json };
      }
      try {
        const response = await deps.request("GET", kind, key);
        if (response.status === 200) {
          const body = (response.body as { json?: unknown; version?: unknown } | null) ?? {};
          await saveLocal(kind, key, body.json ?? null, typeof body.version === "string" ? body.version : null, false);
          return { source: "remote", json: body.json ?? null };
        }
        if (response.status === 404) return { source: "none", json: null };
        return { source: "error", json: null, code: codeOf(response) };
      } catch {
        return { source: "error", json: null, code: "network" };
      }
    },

    /** Stores a value obtained elsewhere (for example the legacy Firestore copy) as a clean local copy. */
    seedLocal: (kind: BlobKind, key: string, json: unknown) => saveLocal(kind, key, json, null, false),

    async write(kind: BlobKind, key: string, json: unknown, fallback?: (json: unknown, code: string) => Promise<boolean>): Promise<void> {
      const id = idOf(kind, key);
      if (fallback) fallbacks.set(id, fallback);
      await saveLocal(kind, key, json, null, true);
      setStatus(id, { state: "saving" });
      persisterFor(kind, key).update(json);
    },

    flush: (kind: BlobKind, key: string) => persisterFor(kind, key).flush(),
    async flushAll(): Promise<void> { await Promise.all([...persisters.values()].map((persister) => persister.flush())); },
    getStatus: (kind: BlobKind, key: string): SaveStatus => statuses.get(idOf(kind, key)) ?? { state: "saved" },
    subscribe(listener: (id: string, status: SaveStatus) => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; },
    idOf,

    async clearLocal(): Promise<void> {
      persisters.forEach((persister) => persister.dispose());
      persisters.clear(); statuses.clear(); fallbacks.clear();
      await deps.local.clearAll();
    },
  };
}

export type BlobClient = ReturnType<typeof createBlobClient>;

/** In-memory LocalBlobStore (tests, and the fallback when IndexedDB is unavailable). */
export function createMemoryBlobStore(): LocalBlobStore {
  const records = new Map<string, LocalBlobRecord>();
  return {
    async get(id) { return records.get(id); },
    async put(record) { records.set(record.id, record); },
    async clearAll() { records.clear(); },
  };
}

/** IndexedDB store: db "study-lamp-blobs", object store "blobs". Falls back to memory without IndexedDB. */
export function createIndexedDbBlobStore(): LocalBlobStore {
  if (typeof indexedDB === "undefined") return createMemoryBlobStore();
  let dbPromise: Promise<IDBDatabase> | null = null;
  const open = () => dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("study-lamp-blobs", 1);
    request.onupgradeneeded = () => { request.result.createObjectStore("blobs", { keyPath: "id" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { dbPromise = null; reject(request.error); };
  });
  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const request = action(db.transaction("blobs", mode).objectStore("blobs"));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  };
  return {
    get: (id) => run("readonly", (store) => store.get(id) as IDBRequest<LocalBlobRecord | undefined>),
    put: async (record) => { await run("readwrite", (store) => store.put(record)); },
    clearAll: async () => { await run("readwrite", (store) => store.clear()); },
  };
}
