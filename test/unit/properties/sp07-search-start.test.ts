import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { EMPTY_VIEW_MODEL } from '../../../src/core/searchProtocol';
import { buildSearchUrl, toSearchQuery } from '../../../src/core/searchQuery';
import {
  DEBOUNCE_MS,
  TIMEOUT_MS,
  applyEvent,
  createControllerHarness,
  searchScriptArb,
  targetSearchIndex,
  toSearchResponse,
  type ScriptEvent,
} from '../searchArbitraries';

// Feature: search-packages, Property 7: Searches start only as typing, Enter, and clearing dictate

type Outcome = 'pending' | 'ok' | 'failed';

interface ModelSearch {
  readonly url: string;
  /** The test already delivered a response for this search (the fake client settles once). */
  testSettled: boolean;
}

/**
 * Reference model of when searches start. It mirrors the spec, not the controller code:
 * Search_Query = clamp 256 + trim; empty query clears; typing restarts a 400 ms debounce; the
 * debounce is skipped when the latest started search has the same query and is pending or ok;
 * Enter starts at once (non-empty) and cancels the debounce; each search has a 10 s timeout.
 */
class SearchStartModel {
  now = 0;
  readonly searches: ModelSearch[] = [];
  /** Number of controller state emissions the model expects (one per start and per effective settle). */
  expectedEmissions = 0;

  private seq = 0;
  private debounce: { due: number; seq: number; query: string } | undefined;
  private inFlight: { index: number; query: string; due: number; seq: number } | undefined;
  private lastStarted: { query: string; outcome: Outcome } | undefined;

  /** Applies one event to the model. */
  apply(event: ScriptEvent): void {
    switch (event.type) {
      case 'query': {
        const query = toSearchQuery(event.text);
        if (query === '') {
          this.debounce = undefined;
          this.inFlight = undefined;
          this.lastStarted = undefined;
        } else {
          this.debounce = { due: this.now + DEBOUNCE_MS, seq: this.seq++, query };
        }
        return;
      }
      case 'submit': {
        this.debounce = undefined;
        const query = toSearchQuery(event.text);
        if (query !== '') {
          this.start(query);
        }
        return;
      }
      case 'advance':
        this.advance(event.ms);
        return;
      case 'settle':
        this.settle(event);
        return;
    }
  }

  private start(query: string): void {
    const built = buildSearchUrl(query);
    if (!built.ok) {
      throw new Error('model started a search for an empty query');
    }
    this.searches.push({ url: built.url, testSettled: false });
    this.inFlight = { index: this.searches.length - 1, query, due: this.now + TIMEOUT_MS, seq: this.seq++ };
    this.lastStarted = { query, outcome: 'pending' };
    this.expectedEmissions++;
  }

  private advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      const candidates: Array<{ due: number; seq: number; kind: 'debounce' | 'timeout' }> = [];
      if (this.debounce !== undefined && this.debounce.due <= target) {
        candidates.push({ due: this.debounce.due, seq: this.debounce.seq, kind: 'debounce' });
      }
      if (this.inFlight !== undefined && this.inFlight.due <= target) {
        candidates.push({ due: this.inFlight.due, seq: this.inFlight.seq, kind: 'timeout' });
      }
      if (candidates.length === 0) {
        break;
      }
      candidates.sort((a, b) => a.due - b.due || a.seq - b.seq);
      const next = candidates[0] as (typeof candidates)[number];
      this.now = Math.max(this.now, next.due);
      if (next.kind === 'debounce') {
        const fired = this.debounce as NonNullable<typeof this.debounce>;
        this.debounce = undefined;
        const last = this.lastStarted;
        const skip = last !== undefined && last.query === fired.query && last.outcome !== 'failed';
        if (!skip) {
          this.start(fired.query);
        }
      } else {
        this.finish('failed');
      }
    }
    this.now = target;
  }

  private settle(event: Extract<ScriptEvent, { type: 'settle' }>): void {
    const target = targetSearchIndex(event.searchIndex, this.searches.length);
    const search = target === undefined ? undefined : this.searches[target];
    if (target === undefined || search === undefined || search.testSettled) {
      return;
    }
    search.testSettled = true;
    if (this.inFlight?.index !== target) {
      return;
    }
    const response = toSearchResponse(event.outcome);
    if (response.kind === 'aborted') {
      return;
    }
    this.finish(response.kind === 'ok' ? 'ok' : 'failed');
  }

  private finish(outcome: 'ok' | 'failed'): void {
    this.inFlight = undefined;
    if (this.lastStarted !== undefined) {
      this.lastStarted.outcome = outcome;
    }
    this.expectedEmissions++;
  }
}

const EMPTY_QUERY_URL = 'https://pkg.go.dev/search?q=&m=package';

describe('Property 7: Searches start only as typing, Enter, and clearing dictate', () => {
  it('starts exactly the searches the reference model predicts, and typing alone never changes the view', async () => {
    await fc.assert(
      fc.asyncProperty(searchScriptArb({ maxLength: 40 }), async (script) => {
        const harness = createControllerHarness();
        const model = new SearchStartModel();

        for (const event of script) {
          const emittedBefore = harness.states.length;
          const stateBefore = harness.controller.state;
          const modelEmissionsBefore = model.expectedEmissions;
          const query = event.type === 'query' ? toSearchQuery(event.text) : undefined;

          await applyEvent(harness, event);
          model.apply(event);

          // Same number of requests, with the same URLs, in the same order (Req 1.1, 1.2, 1.4, 1.5, 1.6).
          expect(harness.client.calls.map((c) => c.url)).toEqual(model.searches.map((s) => s.url));

          const emitted = harness.states.length - emittedBefore;
          if (query === '') {
            // Clearing emits at most one state, and only when something was visible; it never searches.
            expect(emitted).toBeLessThanOrEqual(1);
          } else {
            // One emission per search start and per effective settlement, nothing else (Req 4.6).
            expect(emitted).toBe(model.expectedEmissions - modelEmissionsBefore);
          }
          if (query !== undefined && query !== '') {
            // Typing a non-empty query leaves the visible state untouched.
            expect(harness.controller.state).toBe(stateBefore);
            expect(emitted).toBe(0);
          }
        }

        // No request is ever made for an empty Search_Query.
        for (const call of harness.client.calls) {
          expect(call.url).not.toBe(EMPTY_QUERY_URL);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('a new controller makes no search call, even as time passes', () => {
    const harness = createControllerHarness();
    expect(harness.client.calls).toHaveLength(0);
    expect(harness.controller.state).toEqual(EMPTY_VIEW_MODEL);
    harness.timers.advance(TIMEOUT_MS * 2);
    expect(harness.client.calls).toHaveLength(0);
    expect(harness.controller.state).toEqual(EMPTY_VIEW_MODEL);
    expect(harness.states).toHaveLength(0);
  });
});
