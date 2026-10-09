/**
 * Tiny in-memory read cache (roadmap P2). Pure: no Firebase import.
 *  - cachedRead(key, ttlMs, loader): returns a fresh cached value, or runs the loader once even for concurrent callers.
 *  - invalidate(prefix): drops every entry whose key starts with the prefix (call after a write to that data).
 * A loader that throws is never cached, and its in-flight entry is removed so the next call retries.
 */
interface Entry<T> { value?: T; expiresAt: number; pending?: Promise<T> }

const entries = new Map<string, Entry<unknown>>();

export function cachedRead<T>(key: string, ttlMs: number, loader: () => Promise<T>, now: () => number = Date.now): Promise<T> {
  const current = entries.get(key) as Entry<T> | undefined;
  if (current) {
    if (current.pending) return current.pending;
    if (current.expiresAt > now()) return Promise.resolve(current.value as T);
  }
  const entry: Entry<T> = { expiresAt: 0 };
  const pending = loader().then(
    (value) => {
      if (entries.get(key) === entry) { entry.value = value; entry.expiresAt = now() + ttlMs; entry.pending = undefined; }
      return value;
    },
    (error: unknown) => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    },
  );
  entry.pending = pending;
  entries.set(key, entry as Entry<unknown>);
  return pending;
}

export function invalidate(prefix: string): void {
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) entries.delete(key);
}

/** Test helper. */
export function clearReadCache(): void { entries.clear(); }
