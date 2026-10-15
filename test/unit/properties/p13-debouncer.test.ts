import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { KeyedDebouncer, type TimerApi } from '../../../src/core/debouncer';

// Feature: goget-manager-extension, Property 13: Debouncer runs only the last scheduled callback per key

const DELAY = 100;

/** Deterministic fake timers with a virtual clock. */
class FakeTimers implements TimerApi<number> {
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

interface ScheduleEvent {
  readonly key: string;
  /** Time to advance after this schedule call, before the next one. */
  readonly gap: number;
}

/** Sequence of schedule events over a small key set; gaps straddle the debounce delay. */
const scheduleSequence = fc.array(
  fc.record({
    key: fc.constantFrom('a', 'b', 'c'),
    gap: fc.oneof(
      { weight: 3, arbitrary: fc.integer({ min: 0, max: DELAY - 1 }) },
      { weight: 1, arbitrary: fc.constant(DELAY) },
      { weight: 2, arbitrary: fc.integer({ min: DELAY, max: DELAY * 3 }) },
    ),
  }),
  { minLength: 1, maxLength: 40 },
);

interface Expected {
  readonly key: string;
  readonly index: number;
  readonly time: number;
}

/** Computes, per key, the last schedule of each burst and its expected fire time. */
function expectedRuns(events: readonly ScheduleEvent[]): Expected[] {
  const times: number[] = [];
  let t = 0;
  for (const e of events) {
    times.push(t);
    t += e.gap;
  }
  const expected: Expected[] = [];
  const keys = new Set(events.map((e) => e.key));
  for (const key of keys) {
    const idxs = events.map((e, i) => (e.key === key ? i : -1)).filter((i) => i >= 0);
    idxs.forEach((idx, n) => {
      const next = idxs[n + 1];
      if (next === undefined || times[next]! - times[idx]! >= DELAY) {
        expected.push({ key, index: idx, time: times[idx]! + DELAY });
      }
    });
  }
  return expected;
}

describe('Property 13: Debouncer runs only the last scheduled callback per key', () => {
  it('runs exactly the last callback of each per-key burst, at last schedule + delay', () => {
    fc.assert(
      fc.property(scheduleSequence, (events) => {
        const timers = new FakeTimers();
        const debouncer = new KeyedDebouncer<string>(DELAY, timers);
        const runs: Array<{ key: string; index: number; time: number }> = [];

        events.forEach((e, index) => {
          debouncer.schedule(e.key, () => runs.push({ key: e.key, index, time: timers.now }));
          timers.advance(e.gap);
        });
        // Let any remaining pending callbacks fire.
        timers.advance(DELAY * 2);

        const expected = expectedRuns(events);
        const sortRuns = <T extends { key: string; index: number }>(xs: T[]) =>
          [...xs].sort((x, y) => x.index - y.index);

        // Same set of runs: one per burst, from the last schedule, at exactly last + delay.
        expect(sortRuns(runs)).toEqual(sortRuns(expected));
        // Never more than one run per scheduled callback (no duplicates).
        expect(new Set(runs.map((r) => r.index)).size).toBe(runs.length);
      }),
      { numRuns: 200 },
    );
  });

  it('does not run anything before the delay elapses and does not let one key affect another', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: DELAY - 1 }),
        fc.integer({ min: 1, max: 10 }),
        (offset, extraSchedules) => {
          const timers = new FakeTimers();
          const debouncer = new KeyedDebouncer<string>(DELAY, timers);
          const ran: string[] = [];

          debouncer.schedule('a', () => ran.push('a'));
          timers.advance(offset);
          // Repeated reschedules of 'b' (same instant) must not delay or cancel 'a'.
          for (let i = 0; i < extraSchedules; i++) {
            debouncer.schedule('b', () => ran.push('b'));
          }
          expect(ran).toEqual([]);
          timers.advance(DELAY - offset);
          expect(ran).toEqual(['a']);
          timers.advance(DELAY);
          expect(ran).toEqual(['a', 'b']);
        },
      ),
      { numRuns: 100 },
    );
  });
});
