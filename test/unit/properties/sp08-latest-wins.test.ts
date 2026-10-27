import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  DEBOUNCE_MS,
  applyEvent,
  createControllerHarness,
  flushPromises,
  plainPage,
  renderPage,
  searchScriptArb,
  targetSearchIndex,
  type ControllerHarness,
  type ScriptEvent,
} from '../searchArbitraries';

const RUNS = 100;

/** A results page whose single entry identifies the search call it answers. */
function markerPage(callIndex: number): { html: string; path: string } {
  const path = `marker.example/call-${callIndex}`;
  const html = renderPage(
    plainPage([{ name: `marker${callIndex}`, path, synopsis: undefined, version: undefined, published: undefined, importedBy: undefined }]),
  );
  return { html, path };
}

/** Invariants that must hold after every event. */
function expectInvariants(h: ControllerHarness, callsBefore: number): void {
  const { client, controller, timers } = h;

  // At most one request is live (neither settled nor aborted).
  expect(client.live.length).toBeLessThanOrEqual(1);

  // One start per event at most, and each start superseded every earlier request first.
  expect(client.calls.length - callsBefore).toBeLessThanOrEqual(1);
  for (const call of client.calls) {
    expect(call.liveEarlier).toEqual([]);
    expect(call.abortEvents).toBeLessThanOrEqual(1);
  }

  // A live request is the latest one, and the view shows it as pending.
  const live = client.live[0];
  if (live !== undefined) {
    expect(live.index).toBe(client.calls.length - 1);
    expect(controller.state.loading).toBe(true);
    expect(controller.state.status).toBe('Searching\u2026');
  }

  // One debounce timer and one timeout timer at most: superseded searches leave no timer behind.
  expect(timers.pendingCount).toBeLessThanOrEqual(2);
}

async function step(h: ControllerHarness, event: ScriptEvent): Promise<void> {
  const callsBefore = h.client.calls.length;
  const stateBefore = h.controller.state;
  const emittedBefore = h.states.length;
  const linesBefore = h.output.lines.length;

  let supersededSettle = false;
  if (event.type === 'settle') {
    const target = targetSearchIndex(event.searchIndex, callsBefore);
    if (target !== undefined) {
      const latest = h.client.calls[callsBefore - 1]!;
      const isCurrent = target === callsBefore - 1 && !latest.settled && !latest.aborted;
      supersededSettle = !isCurrent;
    }
  }

  await applyEvent(h, event);

  if (supersededSettle || event.type === 'settle' && event.outcome.kind === 'aborted') {
    // A late response, error, or abort report for a superseded or aborted search changes nothing.
    expect(h.controller.state).toBe(stateBefore);
    expect(h.states.length).toBe(emittedBefore);
    expect(h.output.lines.length).toBe(linesBefore);
    expect(h.client.calls.length).toBe(callsBefore);
  }
  expectInvariants(h, callsBefore);
}

describe('Property 8', () => {
  // Feature: search-packages, Property 8: The latest search wins and at most one request is in flight
  // **Validates: Requirements 1.3, 4.7, 6.1, 6.5, 6.9, 8.5**
  it('keeps at most one request live, ignores superseded outcomes, and shows only the latest search', async () => {
    await fc.assert(
      fc.asyncProperty(searchScriptArb({ minLength: 1, maxLength: 40 }), async (script) => {
        const h = createControllerHarness();

        for (const event of script) {
          await step(h, event);
        }

        // Let a pending debounce fire, then answer every unanswered request out of order:
        // older ones first (late responses), the latest last.
        await step(h, { type: 'advance', ms: DEBOUNCE_MS });
        const latest = h.client.calls[h.client.calls.length - 1];
        const latestIsLive = latest !== undefined && !latest.settled && !latest.aborted;

        for (const call of [...h.client.calls].reverse()) {
          if (call === latest && latestIsLive) {
            continue;
          }
          const stateBefore = h.controller.state;
          const emittedBefore = h.states.length;
          const linesBefore = h.output.lines.length;
          call.settle({ kind: 'ok', html: markerPage(call.index).html });
          await flushPromises();
          expect(h.controller.state).toBe(stateBefore);
          expect(h.states.length).toBe(emittedBefore);
          expect(h.output.lines.length).toBe(linesBefore);
        }

        if (latest !== undefined && latestIsLive) {
          const versionBefore = h.controller.state.resultsVersion;
          const marker = markerPage(latest.index);
          latest.settle({ kind: 'ok', html: marker.html });
          await flushPromises();

          const state = h.controller.state;
          expect(state.results.map((r) => r.path)).toEqual([marker.path]);
          expect(state.status).toBe('1 result');
          expect(state.loading).toBe(false);
          expect(state.resultsVersion).toBe(versionBefore + 1);
          expect(h.client.live).toEqual([]);
        }
        expect(h.client.live.length).toBeLessThanOrEqual(1);
      }),
      { numRuns: RUNS },
    );
  });
});
