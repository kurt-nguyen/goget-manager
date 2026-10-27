import { describe, expect, it } from 'vitest';
import { EMPTY_VIEW_MODEL } from '../../src/core/searchProtocol';
import {
  FIXED_TIMESTAMP,
  createControllerHarness,
  flushPromises,
  plainPage,
  renderPage,
  type ControllerHarness,
  type EntrySpec,
  type HarnessOptions,
} from './searchArbitraries';

const MONGO: EntrySpec = {
  name: 'mongo',
  path: 'go.mongodb.org/mongo-driver/v2/mongo',
  synopsis: 'Package mongo provides a MongoDB Driver API for Go.',
  version: 'v2.0.0',
  published: 'Oct 6, 2026',
  importedBy: '1,289',
};
const MGO: EntrySpec = { ...MONGO, name: 'mgo', path: 'gopkg.in/mgo.v2' };

const PAGE_TWO = renderPage(plainPage([MONGO, MGO]));
const PAGE_ONE = renderPage(plainPage([MGO]));
const SEARCH_URL = 'https://pkg.go.dev/search?q=mongodb&m=package';

async function settleOk(h: ControllerHarness, callIndex: number, html: string): Promise<void> {
  h.client.calls[callIndex]!.settle({ kind: 'ok', html });
  await flushPromises();
}

/** Submits "mongodb" and settles it with a two-result page. */
async function withResults(options: HarnessOptions = {}): Promise<ControllerHarness> {
  const h = createControllerHarness(options);
  h.controller.submit('mongodb');
  await settleOk(h, 0, PAGE_TWO);
  expect(h.controller.state.results.map((r) => r.path)).toEqual([MONGO.path, MGO.path]);
  return h;
}

describe('SearchController', () => {
  // Requirements 1.5, 7.6
  describe('initial state', () => {
    it('starts with the empty view model and makes no client call', () => {
      const h = createControllerHarness();
      expect(h.controller.state).toBe(EMPTY_VIEW_MODEL);
      expect(h.controller.state).toEqual({ results: [], status: '', loading: false, resultsVersion: 0 });
      expect(h.client.calls).toHaveLength(0);
      expect(h.timers.pendingCount).toBe(0);
      expect(h.states).toHaveLength(0);
      expect(h.output.lines).toHaveLength(0);
    });

    it('still makes no client call after time passes', () => {
      const h = createControllerHarness();
      h.timers.advance(60_000);
      expect(h.client.calls).toHaveLength(0);
      expect(h.controller.state).toBe(EMPTY_VIEW_MODEL);
    });

    it('sends no request while the Search_Query stays empty', () => {
      const h = createControllerHarness();
      h.controller.queryChanged('');
      h.controller.queryChanged('   \t ');
      h.timers.advance(5_000);
      expect(h.client.calls).toHaveLength(0);
      expect(h.controller.state).toBe(EMPTY_VIEW_MODEL);
      expect(h.states).toHaveLength(0);
    });
  });

  // Requirement 1.6
  describe('Enter with an empty Search_Query', () => {
    it('changes nothing on a fresh controller', () => {
      const h = createControllerHarness();
      h.controller.submit('');
      h.controller.submit(' \t\n ');
      expect(h.client.calls).toHaveLength(0);
      expect(h.controller.state).toBe(EMPTY_VIEW_MODEL);
      expect(h.states).toHaveLength(0);
      expect(h.timers.pendingCount).toBe(0);
    });

    it('leaves the Result_List and Status_Message unchanged', async () => {
      const h = await withResults();
      const before = h.controller.state;
      const emitted = h.states.length;

      h.controller.submit('   ');
      h.controller.submit('');

      expect(h.client.calls).toHaveLength(1);
      expect(h.controller.state).toBe(before);
      expect(h.states).toHaveLength(emitted);
      expect(h.output.lines).toHaveLength(0);
    });
  });

  // Requirement 6.8
  describe('Enter after a failure', () => {
    it('re-searches the same query', async () => {
      const h = createControllerHarness();
      h.controller.submit('mongodb');
      h.client.calls[0]!.settle({ kind: 'failed', failure: { kind: 'http', status: 503 } });
      await flushPromises();
      expect(h.controller.state.status).toBe('pkg.go.dev returned an error (HTTP 503). Try again later.');
      expect(h.controller.state.loading).toBe(false);

      h.controller.submit('mongodb');

      expect(h.client.calls).toHaveLength(2);
      expect(h.client.calls[1]!.url).toBe(SEARCH_URL);
      expect(h.controller.state.loading).toBe(true);
      expect(h.controller.state.status).toBe('Searching\u2026');

      await settleOk(h, 1, PAGE_ONE);
      expect(h.controller.state.status).toBe('1 result');
      expect(h.controller.state.results.map((r) => r.path)).toEqual([MGO.path]);
    });

    it('re-searches the same query after a timeout', async () => {
      const h = createControllerHarness();
      h.controller.submit('mongodb');
      h.timers.advance(10_000);
      expect(h.controller.state.status).toBe('The search timed out. Try again.');

      h.controller.submit('mongodb');

      expect(h.client.calls).toHaveLength(2);
      expect(h.client.calls[1]!.url).toBe(SEARCH_URL);
      expect(h.controller.state.loading).toBe(true);
    });

    it('also searches again on Enter after a success with the same query', async () => {
      const h = await withResults();
      h.controller.submit('mongodb');
      expect(h.client.calls).toHaveLength(2);
    });

    it('retries a failed query when the debounce fires again', async () => {
      const h = createControllerHarness();
      h.controller.queryChanged('mongodb');
      h.timers.advance(400);
      h.client.calls[0]!.settle({ kind: 'failed', failure: { kind: 'unreachable', reason: 'ENOTFOUND' } });
      await flushPromises();

      h.controller.queryChanged('mongodb ');
      h.timers.advance(400);

      expect(h.client.calls).toHaveLength(2);
    });
  });

  // Requirement 6.5
  describe('Request_Timeout', () => {
    it('counts from the start of the search, not from the first keystroke', () => {
      const h = createControllerHarness();
      h.controller.queryChanged('mongodb');
      h.timers.advance(399);
      expect(h.client.calls).toHaveLength(0);
      h.timers.advance(1);
      expect(h.client.calls).toHaveLength(1);

      // The search started at t = 400; 10 s later is t = 10_400.
      h.timers.advance(9_999);
      expect(h.controller.state.loading).toBe(true);
      expect(h.client.calls[0]!.aborted).toBe(false);
      expect(h.output.lines).toHaveLength(0);

      h.timers.advance(1);
      expect(h.client.calls[0]!.aborted).toBe(true);
      expect(h.controller.state.loading).toBe(false);
    });

    it('counts from the start of a search submitted late in the session', () => {
      const h = createControllerHarness();
      h.timers.advance(5_000);
      h.controller.submit('mongodb');
      h.timers.advance(9_999);
      expect(h.controller.state.loading).toBe(true);
      h.timers.advance(1);
      expect(h.controller.state.loading).toBe(false);
    });

    it('aborts the request and shows the timeout message with one log line and no notification', () => {
      const h = createControllerHarness();
      h.controller.submit('mongodb');
      h.timers.advance(10_000);

      const call = h.client.calls[0]!;
      expect(call.aborted).toBe(true);
      expect(call.abortEvents).toBe(1);
      expect(h.controller.state).toMatchObject({
        results: [],
        status: 'The search timed out. Try again.',
        loading: false,
      });
      expect(h.output.lines).toEqual([`[${FIXED_TIMESTAMP}] Search for "mongodb" failed: timeout after 10 s`]);
      expect(h.errors).toHaveLength(0);
      expect(h.timers.pendingCount).toBe(0);
    });

    it('removes earlier results when the search times out', async () => {
      const h = await withResults();
      h.controller.submit('mongodb');
      h.timers.advance(10_000);
      expect(h.controller.state.results).toEqual([]);
      expect(h.controller.state.status).toBe('The search timed out. Try again.');
    });

    it('ignores a late response after the timeout', async () => {
      const h = createControllerHarness();
      h.controller.submit('mongodb');
      h.timers.advance(10_000);
      const after = h.controller.state;
      const emitted = h.states.length;

      await settleOk(h, 0, PAGE_TWO);

      expect(h.controller.state).toBe(after);
      expect(h.states).toHaveLength(emitted);
      expect(h.output.lines).toHaveLength(1);
    });

    it('does not time out a search that settled in time', async () => {
      const h = createControllerHarness();
      h.controller.submit('mongodb');
      h.timers.advance(9_000);
      await settleOk(h, 0, PAGE_TWO);
      expect(h.timers.pendingCount).toBe(0);
      h.timers.advance(60_000);
      expect(h.controller.state.status).toBe('2 results');
      expect(h.output.lines).toHaveLength(0);
    });

    it('does not let the timeout of a superseded search affect the newer one', () => {
      const h = createControllerHarness();
      h.controller.submit('mongodb');
      h.timers.advance(6_000);
      h.controller.submit('mongodb');
      expect(h.client.calls[0]!.aborted).toBe(true);

      // t = 10_000: the first search's timer would have fired.
      h.timers.advance(4_000);
      expect(h.controller.state.loading).toBe(true);
      expect(h.output.lines).toHaveLength(0);

      // t = 16_000: the second search's own timeout.
      h.timers.advance(6_000);
      expect(h.controller.state.status).toBe('The search timed out. Try again.');
      expect(h.output.lines).toHaveLength(1);
    });
  });

  // Requirement 1.2
  describe('clearing the Search_Box', () => {
    it('aborts the in-flight search and clears the state', () => {
      const h = createControllerHarness();
      h.controller.submit('mongodb');
      expect(h.controller.state.loading).toBe(true);

      h.controller.queryChanged('');

      expect(h.client.calls[0]!.aborted).toBe(true);
      expect(h.controller.state).toMatchObject({ results: [], status: '', loading: false });
      expect(h.timers.pendingCount).toBe(0);
    });

    it('ignores a response that arrives after clearing', async () => {
      const h = createControllerHarness();
      h.controller.submit('mongodb');
      h.controller.queryChanged('   ');
      const after = h.controller.state;
      const emitted = h.states.length;

      await settleOk(h, 0, PAGE_TWO);

      expect(h.controller.state).toBe(after);
      expect(h.states).toHaveLength(emitted);
      expect(h.controller.state.results).toEqual([]);
      expect(h.controller.state.status).toBe('');
    });

    it('removes displayed results and the status', async () => {
      const h = await withResults();
      const versionBefore = h.controller.state.resultsVersion;

      h.controller.queryChanged('');

      expect(h.controller.state).toMatchObject({ results: [], status: '', loading: false });
      expect(h.controller.state.resultsVersion).toBeGreaterThan(versionBefore);
    });

    it('cancels a pending debounced search', () => {
      const h = createControllerHarness();
      h.controller.queryChanged('mongodb');
      h.controller.queryChanged('');
      h.timers.advance(5_000);
      expect(h.client.calls).toHaveLength(0);
      expect(h.controller.state).toBe(EMPTY_VIEW_MODEL);
    });

    it('does not report a timeout for a search that was cleared', () => {
      const h = createControllerHarness();
      h.controller.submit('mongodb');
      h.controller.queryChanged('');
      h.timers.advance(60_000);
      expect(h.output.lines).toHaveLength(0);
      expect(h.controller.state).toMatchObject({ results: [], status: '', loading: false });
    });

    it('starts a fresh search for the same text typed again', () => {
      const h = createControllerHarness();
      h.controller.queryChanged('mongodb');
      h.timers.advance(400);
      h.controller.queryChanged('');
      h.controller.queryChanged('mongodb');
      h.timers.advance(400);
      expect(h.client.calls).toHaveLength(2);
    });
  });

  // Requirements 5.5, 6.7
  describe('openExternal failures', () => {
    it('shows one notification and writes one log line when openExternal returns false', async () => {
      const urls: string[] = [];
      const h = await withResults({
        openExternal: (url) => {
          urls.push(url);
          return Promise.resolve(false);
        },
      });
      const { resultsVersion } = h.controller.state;
      const before = h.controller.state;
      const emitted = h.states.length;

      await h.controller.open(resultsVersion, 0);

      expect(urls).toEqual([`https://pkg.go.dev/${MONGO.path}`]);
      expect(h.errors).toEqual([`Could not open the pkg.go.dev page for ${MONGO.path}.`]);
      expect(h.output.lines).toHaveLength(1);
      expect(h.output.lines[0]).toBe(
        `[${FIXED_TIMESTAMP}] Could not open package page for ${JSON.stringify(MONGO.path)}: the browser could not be opened`,
      );
      expect(h.controller.state).toBe(before);
      expect(h.states).toHaveLength(emitted);
      expect(h.client.calls).toHaveLength(1);
    });

    it('shows one notification and writes one log line when openExternal rejects', async () => {
      const urls: string[] = [];
      const h = await withResults({
        openExternal: (url) => {
          urls.push(url);
          return Promise.reject(new Error('no browser available'));
        },
      });
      const { resultsVersion } = h.controller.state;
      const before = h.controller.state;
      const emitted = h.states.length;

      await h.controller.open(resultsVersion, 1);

      expect(urls).toEqual([`https://pkg.go.dev/${MGO.path}`]);
      expect(h.errors).toEqual([`Could not open the pkg.go.dev page for ${MGO.path}.`]);
      expect(h.output.lines).toEqual([
        `[${FIXED_TIMESTAMP}] Could not open package page for ${JSON.stringify(MGO.path)}: no browser available`,
      ]);
      expect(h.controller.state).toBe(before);
      expect(h.states).toHaveLength(emitted);
    });

    it('uses the error code as the reason when the rejection carries one', async () => {
      const h = await withResults({
        openExternal: () => Promise.reject(Object.assign(new Error('spawn failed'), { code: 'ENOENT' })),
      });
      await h.controller.open(h.controller.state.resultsVersion, 0);
      expect(h.output.lines).toHaveLength(1);
      expect(h.output.lines[0]).toMatch(/: ENOENT$/);
    });

    it('shows no notification and writes no log line when the page opens', async () => {
      const h = await withResults();
      await h.controller.open(h.controller.state.resultsVersion, 0);
      expect(h.opened).toEqual([`https://pkg.go.dev/${MONGO.path}`]);
      expect(h.errors).toHaveLength(0);
      expect(h.output.lines).toHaveLength(0);
    });

    it('shows no notification for a search failure', async () => {
      const h = createControllerHarness();
      h.controller.submit('mongodb');
      h.client.calls[0]!.settle({ kind: 'failed', failure: { kind: 'unreachable', reason: 'ENOTFOUND' } });
      await flushPromises();
      expect(h.errors).toHaveLength(0);
      expect(h.output.lines).toEqual([`[${FIXED_TIMESTAMP}] Search for "mongodb" failed: unreachable (ENOTFOUND)`]);
    });
  });

  // Requirement 5.1: results are addressed by version, so a stale click cannot open the wrong page
  describe('stale resultsVersion', () => {
    it('is ignored after the results were replaced', async () => {
      const h = await withResults();
      const staleVersion = h.controller.state.resultsVersion;
      h.controller.submit('mongodb');
      await settleOk(h, 1, PAGE_ONE);
      expect(h.controller.state.resultsVersion).toBeGreaterThan(staleVersion);
      const before = h.controller.state;
      const emitted = h.states.length;

      await h.controller.open(staleVersion, 0);

      expect(h.opened).toHaveLength(0);
      expect(h.errors).toHaveLength(0);
      expect(h.output.lines).toHaveLength(0);
      expect(h.controller.state).toBe(before);
      expect(h.states).toHaveLength(emitted);
    });

    it('is ignored after the results were cleared', async () => {
      const h = await withResults();
      const staleVersion = h.controller.state.resultsVersion;
      h.controller.queryChanged('');

      await h.controller.open(staleVersion, 0);

      expect(h.opened).toHaveLength(0);
      expect(h.errors).toHaveLength(0);
      expect(h.output.lines).toHaveLength(0);
    });

    it('opens the entry of the current version at the same index', async () => {
      const h = await withResults();
      h.controller.submit('mongodb');
      await settleOk(h, 1, PAGE_ONE);

      await h.controller.open(h.controller.state.resultsVersion, 0);

      expect(h.opened).toEqual([`https://pkg.go.dev/${MGO.path}`]);
    });

    it('ignores an index beyond the current results', async () => {
      const h = await withResults();
      await h.controller.open(h.controller.state.resultsVersion, 2);
      expect(h.opened).toHaveLength(0);
      expect(h.errors).toHaveLength(0);
      expect(h.output.lines).toHaveLength(0);
    });
  });

  describe('listeners', () => {
    it('keeps notifying other listeners when one throws, and logs the failure', () => {
      const h = createControllerHarness();
      const seenBefore: unknown[] = [];
      const seenAfter: unknown[] = [];
      h.controller.onDidChangeState((state) => {
        seenBefore.push(state);
      });
      h.controller.onDidChangeState(() => {
        throw new Error('listener boom');
      });
      h.controller.onDidChangeState((state) => {
        seenAfter.push(state);
      });

      expect(() => {
        h.controller.submit('mongodb');
      }).not.toThrow();

      expect(h.client.calls).toHaveLength(1);
      expect(seenBefore).toHaveLength(1);
      expect(seenAfter).toHaveLength(1);
      expect(h.states).toHaveLength(1);
      expect(seenAfter[0]).toBe(h.controller.state);
      expect(h.output.lines).toHaveLength(1);
      expect(h.output.lines[0]).toContain(`[${FIXED_TIMESTAMP}] Listener failed:`);
      expect(h.output.lines[0]).toContain('listener boom');
    });

    it('still settles the search and notifies later listeners after a listener threw', async () => {
      const h = createControllerHarness();
      h.controller.onDidChangeState(() => {
        throw new Error('listener boom');
      });
      const seen: string[] = [];
      h.controller.onDidChangeState((state) => {
        seen.push(state.status);
      });

      h.controller.submit('mongodb');
      await settleOk(h, 0, PAGE_TWO);

      expect(seen).toEqual(['Searching\u2026', '2 results']);
      expect(h.controller.state.status).toBe('2 results');
    });

    it('stops notifying a listener once it is disposed', () => {
      const h = createControllerHarness();
      const seen: unknown[] = [];
      const subscription = h.controller.onDidChangeState((state) => {
        seen.push(state);
      });
      subscription.dispose();
      h.controller.submit('mongodb');
      expect(seen).toHaveLength(0);
      expect(h.states).toHaveLength(1);
    });
  });
});
