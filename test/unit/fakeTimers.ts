import type { TimerApi } from '../../src/core/debouncer';

/** Deterministic fake timers with a virtual clock. */
export class FakeTimers implements TimerApi<number> {
  now = 0;
  private nextId = 1;
  private readonly timers = new Map<number, { due: number; cb: () => void }>();

  setTimeout(callback: () => void, delayMs: number): number {
    const id = this.nextId++;
    this.timers.set(id, { due: this.now + delayMs, cb: callback });
    return id;
  }

  clearTimeout(handle: number): void {
    this.timers.delete(handle);
  }

  /** Number of timers that are scheduled and have not fired or been cleared. */
  get pendingCount(): number {
    return this.timers.size;
  }

  /** Advances the clock, firing due timers in (due time, creation) order. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let bestId: number | undefined;
      let bestDue = Infinity;
      for (const [id, t] of this.timers) {
        if (t.due <= target && t.due < bestDue) {
          bestDue = t.due;
          bestId = id;
        }
      }
      if (bestId === undefined) {
        break;
      }
      const t = this.timers.get(bestId)!;
      this.timers.delete(bestId);
      this.now = Math.max(this.now, t.due);
      t.cb();
    }
    this.now = target;
  }
}
