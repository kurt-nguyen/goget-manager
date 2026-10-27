import { describe, expect, it, vi } from 'vitest';
import { flushPromises, createControllerHarness, FIXED_TIMESTAMP } from './searchArbitraries';

// The real parser never emits an empty package path, so the refused-path branch of
// `SearchController.open` (Requirement 5.4) is only reachable with a stubbed parser.
const parsed = vi.hoisted(() => ({
  results: [] as { path: string; name: string }[],
}));

vi.mock('../../src/core/resultsParser', () => ({
  parseSearchResults: () => parsed.results,
}));

describe('SearchController.open with a refused package page', () => {
  async function harnessWith(results: { path: string; name: string }[]) {
    parsed.results = results;
    const h = createControllerHarness();
    h.controller.submit('mongodb');
    h.client.calls[0]!.settle({ kind: 'ok', html: '<html></html>' });
    await flushPromises();
    expect(h.controller.state.results).toEqual(results);
    return h;
  }

  it('writes one log line and opens nothing when the package path is empty', async () => {
    const h = await harnessWith([{ path: '', name: 'broken' }]);
    const before = h.controller.state;
    const emitted = h.states.length;

    await h.controller.open(before.resultsVersion, 0);

    expect(h.opened).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
    expect(h.output.lines).toEqual([`[${FIXED_TIMESTAMP}] Did not open package page for "": empty package path`]);
    expect(h.controller.state).toBe(before);
    expect(h.states).toHaveLength(emitted);
  });

  it('still opens a valid entry next to a refused one', async () => {
    const h = await harnessWith([
      { path: '', name: 'broken' },
      { path: 'gopkg.in/mgo.v2', name: 'mgo' },
    ]);
    const { resultsVersion } = h.controller.state;

    await h.controller.open(resultsVersion, 0);
    await h.controller.open(resultsVersion, 1);

    expect(h.opened).toEqual(['https://pkg.go.dev/gopkg.in/mgo.v2']);
    expect(h.output.lines).toHaveLength(1);
    expect(h.errors).toHaveLength(0);
  });
});
