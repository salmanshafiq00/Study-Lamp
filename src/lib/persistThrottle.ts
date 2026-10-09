/**
 * Throttled, change-aware persister (roadmap P3). Pure: no React, no Firebase.
 *  - writes at most once per `minIntervalMs`;
 *  - only when the value changed (`equals`) AND moved enough (`isSignificant`, default: any change);
 *  - flush() writes the pending value now if it differs from the last written one (pause / end / pagehide);
 *  - a failed write keeps the pending value and retries after the interval.
 */
export interface PersisterOptions<T> {
  write: (value: T) => Promise<void>;
  equals?: (a: T, b: T) => boolean;
  isSignificant?: (last: T, next: T) => boolean;
  minIntervalMs?: number;
  /** Delay before retrying after the Nth consecutive failed write (default: minIntervalMs). */
  retryDelayMs?: (consecutiveFailures: number) => number;
  /** Value already stored, so an identical first update is skipped. */
  initial?: T;
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface Persister<T> {
  update(value: T): void;
  flush(): Promise<boolean>;
  hasPending(): boolean;
  dispose(): void;
}

export function createPersister<T>(options: PersisterOptions<T>): Persister<T> {
  const minInterval = options.minIntervalMs ?? 60_000;
  const equals = options.equals ?? ((a: T, b: T) => JSON.stringify(a) === JSON.stringify(b));
  const isSignificant = options.isSignificant ?? (() => true);
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let last: { value: T } | undefined = options.initial !== undefined ? { value: options.initial } : undefined;
  let pending: { value: T } | undefined;
  let lastWriteAt = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  let inFlight: Promise<boolean> | null = null;
  let disposed = false;
  let failures = 0;

  const stopTimer = () => { if (timer !== undefined) { clearTimer(timer); timer = undefined; } };
  const arm = (ms: number) => {
    stopTimer();
    timer = setTimer(() => { timer = undefined; void writePending(); }, ms);
  };

  async function writePending(): Promise<boolean> {
    stopTimer();
    if (inFlight) return inFlight.then(() => (pending ? writePending() : true));
    const item = pending;
    if (!item) return true;
    if (last && equals(last.value, item.value)) { pending = undefined; return true; }
    pending = undefined;
    inFlight = (async () => {
      try {
        await options.write(item.value);
        last = { value: item.value };
        lastWriteAt = now();
        failures = 0;
        return true;
      } catch {
        if (!pending) pending = item; // keep the newest value for the retry
        failures += 1;
        if (!disposed) arm(options.retryDelayMs ? options.retryDelayMs(failures) : minInterval);
        return false;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return {
    update(value) {
      if (disposed) return;
      if (last && equals(last.value, value)) { pending = undefined; stopTimer(); return; }
      pending = { value };
      if (last && !isSignificant(last.value, value)) return; // small drift: wait for flush()
      const wait = Math.max(0, lastWriteAt + minInterval - now());
      if (wait === 0) void writePending();
      else if (timer === undefined) arm(wait);
    },
    flush: () => writePending(),
    hasPending: () => pending !== undefined,
    dispose() { disposed = true; stopTimer(); },
  };
}
