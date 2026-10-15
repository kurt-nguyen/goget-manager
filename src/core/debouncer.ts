/**
 * Minimal timer abstraction so tests can drive time deterministically.
 * `H` is an opaque handle returned by `setTimeout` and accepted by `clearTimeout`.
 */
export interface TimerApi<H = unknown> {
  setTimeout(callback: () => void, delayMs: number): H;
  clearTimeout(handle: H): void;
}

/** Default timer API backed by the global `setTimeout` / `clearTimeout`. */
export const defaultTimerApi: TimerApi = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface Pending {
  readonly handle: unknown;
  readonly fn: () => void;
}

/**
 * Debounces callbacks per key. Each key has at most one pending callback.
 * Scheduling again for the same key replaces the callback and restarts the delay.
 * Different keys are independent.
 */
export class KeyedDebouncer<K> {
  private readonly pending = new Map<K, Pending>();
  private disposed = false;

  constructor(
    private readonly delayMs: number,
    private readonly timers: TimerApi = defaultTimerApi,
  ) {}

  /** Schedules `fn` for `key`, replacing any pending callback and restarting the delay. */
  schedule(key: K, fn: () => void): void {
    if (this.disposed) {
      return;
    }
    this.cancel(key);
    const handle = this.timers.setTimeout(() => {
      // Only fire if this timer is still the current one for the key.
      const current = this.pending.get(key);
      if (current === undefined || current.handle !== handle) {
        return;
      }
      this.pending.delete(key);
      current.fn();
    }, this.delayMs);
    this.pending.set(key, { handle, fn });
  }

  /** Runs the pending callback for `key` immediately, if there is one. */
  flush(key: K): void {
    const current = this.pending.get(key);
    if (current === undefined) {
      return;
    }
    this.pending.delete(key);
    this.timers.clearTimeout(current.handle);
    current.fn();
  }

  /** Drops the pending callback for `key` without running it. */
  cancel(key: K): void {
    const current = this.pending.get(key);
    if (current === undefined) {
      return;
    }
    this.pending.delete(key);
    this.timers.clearTimeout(current.handle);
  }

  /** Cancels every pending callback. Later `schedule` calls are ignored. */
  dispose(): void {
    this.disposed = true;
    for (const current of this.pending.values()) {
      this.timers.clearTimeout(current.handle);
    }
    this.pending.clear();
  }
}
