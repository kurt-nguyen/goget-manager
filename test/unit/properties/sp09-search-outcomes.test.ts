import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { SearchViewModel } from '../../../src/core/searchProtocol';
import {
  FIXED_TIMESTAMP,
  createControllerHarness,
  flushPromises,
  queryArb,
  settleOutcomeArb,
  toSearchResponse,
  whitespaceArb,
  type ControllerHarness,
  type SettleOutcome,
} from '../searchArbitraries';

const RUNS = 100;
const TIMEOUT_MS = 10_000;

type FinalOutcome = Exclude<SettleOutcome, { kind: 'aborted' }> | { kind: 'timeout' };

const settledOutcomeArb = settleOutcomeArb.filter(
  (o): o is Exclude<SettleOutcome, { kind: 'aborted' }> => o.kind !== 'aborted',
);

const finalOutcomeArb: fc.Arbitrary<FinalOutcome> = fc.oneof(
  { weight: 3, arbitrary: settledOutcomeArb },
  { weight: 1, arbitrary: fc.constant<FinalOutcome>({ kind: 'timeout' }) },
);

// Literal templates (deliberately not the messages.ts helpers).
const SEARCHING_TEXT = 'Searching\u2026';
const UNREACHABLE_TEXT = 'Could not reach pkg.go.dev. Check your internet connection and try again.';
const TIMED_OUT_TEXT = 'The search timed out. Try again.';

function expectedStatus(outcome: FinalOutcome, query: string): string {
  switch (outcome.kind) {
    case 'ok':
      return outcome.results.length === 0
        ? `No packages found for "${query}".`
        : outcome.results.length === 1
          ? '1 result'
          : `${outcome.results.length} results`;
    case 'unreachable':
      return UNREACHABLE_TEXT;
    case 'http':
    case 'redirectBlocked':
      return `pkg.go.dev returned an error (HTTP ${outcome.status}). Try again later.`;
    case 'timeout':
      return TIMED_OUT_TEXT;
  }
}

function expectedLog(outcome: FinalOutcome, query: string): string | undefined {
  const prefix = `[${FIXED_TIMESTAMP}] Search for ${JSON.stringify(query)} failed: `;
  switch (outcome.kind) {
    case 'ok':
      return undefined;
    case 'unreachable':
      return `${prefix}unreachable (${outcome.reason.replace(/[\r\n\u2028\u2029]+/g, ' ')})`;
    case 'http':
      return `${prefix}HTTP error ${outcome.status}`;
    case 'redirectBlocked':
      return `${prefix}HTTP error ${outcome.status}, redirect to host ${outcome.targetHost} blocked`;
    case 'timeout':
      return `${prefix}timeout after 10 s`;
  }
}

function expectedResultsOf(outcome: FinalOutcome): SearchViewModel['results'] {
  return outcome.kind === 'ok' ? outcome.results : [];
}

async function settleLast(harness: ControllerHarness, outcome: SettleOutcome): Promise<void> {
  const call = harness.client.calls[harness.client.calls.length - 1];
  call?.settle(toSearchResponse(outcome));
  await flushPromises();
}

/** Drives a search to its end and returns the state right after it settled. */
async function finish(
  harness: ControllerHarness,
  outcome: FinalOutcome,
  splitMs: number,
  late: SettleOutcome | undefined,
): Promise<void> {
  if (outcome.kind === 'timeout') {
    // Not yet timed out just before 10 s from the start of the search.
    const first = Math.min(splitMs, TIMEOUT_MS - 1);
    harness.timers.advance(first);
    expect(harness.controller.state.loading).toBe(true);
    expect(harness.controller.state.status).toBe(SEARCHING_TEXT);
    harness.timers.advance(TIMEOUT_MS - 1 - first);
    expect(harness.controller.state.loading).toBe(true);
    expect(harness.client.calls[harness.client.calls.length - 1]?.aborted).toBe(false);
    harness.timers.advance(1);
    expect(harness.client.calls[harness.client.calls.length - 1]?.aborted).toBe(true);
    if (late !== undefined) {
      // A response that arrives after the timeout changes nothing.
      const before = harness.controller.state;
      const lines = harness.output.lines.length;
      await settleLast(harness, late);
      expect(harness.controller.state).toBe(before);
      expect(harness.output.lines).toHaveLength(lines);
    }
    return;
  }
  await settleLast(harness, outcome);
}

describe('Property 9', () => {
  // Feature: search-packages, Property 9: Search outcomes map to the exact view state and one log line
  // **Validates: Requirements 4.5, 6.2, 6.3, 6.4, 6.6, 6.7, 8.3, 8.4**
  it('maps every search outcome to the exact view state, one log line for failures, and no notification', async () => {
    await fc.assert(
      fc.asyncProperty(
        queryArb,
        queryArb,
        whitespaceArb,
        whitespaceArb,
        fc.option(settledOutcomeArb, { nil: undefined }),
        finalOutcomeArb,
        fc.nat({ max: TIMEOUT_MS - 1 }),
        fc.option(settleOutcomeArb, { nil: undefined }),
        async (priorQuery, query, padLeft, padRight, prior, outcome, splitMs, late) => {
          const harness = createControllerHarness();
          const { controller, client, output } = harness;

          // Optionally leave results (or a failure) from an earlier search on screen.
          if (prior !== undefined) {
            controller.submit(priorQuery);
            await settleLast(harness, prior);
          }
          const before = controller.state;
          const linesBefore = output.lines.length;
          const callsBefore = client.calls.length;

          // Start: previous results kept, loading true, "Searching…", nothing logged yet.
          controller.submit(`${padLeft}${query}${padRight}`);
          expect(client.calls).toHaveLength(callsBefore + 1);
          const searching = controller.state;
          expect(searching.status).toBe(SEARCHING_TEXT);
          expect(searching.loading).toBe(true);
          expect(searching.results).toEqual(before.results);
          expect(searching.resultsVersion).toBe(before.resultsVersion);
          expect(output.lines).toHaveLength(linesBefore);

          await finish(harness, outcome, splitMs, late);

          // Settled state.
          const state = controller.state;
          expect(state.loading).toBe(false);
          expect(state.status).toBe(expectedStatus(outcome, query));
          expect(state.results).toEqual(expectedResultsOf(outcome));
          expect(state.resultsVersion).toBe(before.resultsVersion + 1);

          // Log: one line for failures, none for success.
          const logged = output.lines.slice(linesBefore);
          const expectedLine = expectedLog(outcome, query);
          if (expectedLine === undefined) {
            expect(logged).toEqual([]);
          } else {
            expect(logged).toEqual([expectedLine]);
            expect(logged[0]).not.toMatch(/[\r\n\u2028\u2029]/);
          }

          // Search failures never raise a notification and never open anything.
          expect(harness.errors).toEqual([]);
          expect(harness.opened).toEqual([]);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('does not time out before 10 s have passed since the search started', async () => {
    await fc.assert(
      fc.asyncProperty(queryArb, fc.nat({ max: TIMEOUT_MS - 1 }), async (query, elapsed) => {
        const harness = createControllerHarness();
        harness.controller.submit(query);
        harness.timers.advance(elapsed);
        expect(harness.controller.state.status).toBe(SEARCHING_TEXT);
        expect(harness.controller.state.loading).toBe(true);
        expect(harness.output.lines).toEqual([]);
        expect(harness.errors).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});
