import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isPkgGoDevHttpsUrl, packagePageUrl } from '../../../src/core/searchQuery';
import {
  FIXED_TIMESTAMP,
  createControllerHarness,
  expectedResults,
  flushPromises,
  plainPage,
  renderPage,
  validEntrySpecArb,
  type ControllerHarness,
  type EntrySpec,
  type HarnessOptions,
} from '../searchArbitraries';

const RUNS = 150;
const PREFIX = 'https://pkg.go.dev/';

// --- generators ------------------------------------------------------------

/** Characters that can appear in Go import paths. */
const goPathCharArb = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789.-_~'.split(''));

const goPathArb: fc.Arbitrary<string> = fc
  .array(fc.string({ unit: goPathCharArb, minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 5 })
  .map((segments) => segments.join('/'));

/** Strings that try to turn the path into authority, userinfo, port, or a different scheme/host. */
const HOSTILE_PREFIXES = [
  '@evil.com',
  '@evil.com/',
  'evil.com@',
  'user:pass@evil.com/',
  '/x',
  '//evil.com',
  '///evil.com',
  '\\x',
  '\\\\x',
  '\\\\evil.com\\',
  '/\\evil.com',
  ':8443',
  ':8443/',
  ':443/',
  ':80@evil.com/',
  '.evil.com',
  '..',
  '../',
  '?',
  '#',
  '%40evil.com',
  '%2F%2Fevil.com',
  '%5Cevil.com',
  'http://evil.com/',
  'https://evil.com/',
  '[::1]/',
  '\u0000',
  '\u3002evil.com',
  '\uff20evil.com',
];

const hostilePathArb: fc.Arbitrary<string> = fc
  .tuple(fc.constantFrom(...HOSTILE_PREFIXES), fc.oneof(fc.constant(''), goPathArb))
  .map(([prefix, rest]) => prefix + rest);

/** Arbitrary text, including code units that are not valid Unicode (lone surrogates), controls, and white space. */
const anyStringArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 40 }),
  fc.string({ unit: 'grapheme', maxLength: 30 }),
  fc.string({ unit: fc.constantFrom(...'@/\\:?#%.[]&=+ \t\n\r\u0000\ud800\udc00'.split('')), maxLength: 20 }),
);

const anyPathArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: anyStringArb },
  { weight: 2, arbitrary: hostilePathArb },
  { weight: 2, arbitrary: goPathArb },
);

/** Displayed paths for the controller: whitespace-free, Go-like or hostile-looking. */
const displayedPathArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: goPathArb },
  { weight: 2, arbitrary: hostilePathArb.filter((p) => !/\s/u.test(p) && p.trim() !== '' && !/[\u0000]/.test(p)) },
);

const specArb: fc.Arbitrary<EntrySpec> = fc
  .tuple(validEntrySpecArb, displayedPathArb)
  .map(([spec, path]) => ({ ...spec, path }));

const specsArb: fc.Arbitrary<EntrySpec[]> = fc.array(specArb, { minLength: 1, maxLength: 5 });

// --- helpers ---------------------------------------------------------------

/** Submits a query on a fresh harness and settles the search with a page rendered from `specs`. */
async function harnessWithResults(specs: readonly EntrySpec[], options: HarnessOptions = {}): Promise<ControllerHarness> {
  const harness = createControllerHarness(options);
  harness.controller.submit('mongodb');
  expect(harness.client.calls).toHaveLength(1);
  harness.client.calls[0]!.settle({ kind: 'ok', html: renderPage(plainPage(specs)) });
  await flushPromises();
  // The displayed paths are exactly what the page was rendered from.
  expect(harness.controller.state.results.map((r) => r.path)).toEqual(expectedResults(specs).map((r) => r.path));
  expect(harness.controller.state.loading).toBe(false);
  expect(harness.controller.state.results.length).toBeGreaterThan(0);
  return harness;
}

interface Snapshot {
  readonly state: ControllerHarness['controller']['state'];
  readonly stateCount: number;
  readonly logLines: number;
}

function snapshot(h: ControllerHarness): Snapshot {
  return { state: h.controller.state, stateCount: h.states.length, logLines: h.output.lines.length };
}

function expectStateUnchanged(h: ControllerHarness, before: Snapshot): void {
  expect(h.controller.state).toBe(before.state);
  expect(h.states).toHaveLength(before.stateCount);
}

function expectNothingHappened(h: ControllerHarness, before: Snapshot, opened: readonly string[]): void {
  expect(opened).toHaveLength(0);
  expect(h.errors).toHaveLength(0);
  expect(h.output.lines).toHaveLength(before.logLines);
  expectStateUnchanged(h, before);
}

describe('Property 11', () => {
  // Feature: search-packages, Property 11: Package pages open only as HTTPS pkg.go.dev URLs built from the displayed path
  // **Validates: Requirements 5.1, 5.4**
  describe('packagePageUrl', () => {
    it('is ok exactly when the URL passes isPkgGoDevHttpsUrl, and an ok URL is the prefix plus the path on pkg.go.dev over HTTPS', () => {
      fc.assert(
        fc.property(anyPathArb, (path) => {
          const result = packagePageUrl(path);
          if (path === '') {
            expect(result).toEqual({ ok: false, reason: 'emptyPath' });
            return;
          }
          const candidate = PREFIX + path;
          expect(result.ok).toBe(isPkgGoDevHttpsUrl(candidate));
          if (!result.ok) {
            expect(result.reason).toBe('notPkgGoDev');
            return;
          }
          // Exactly the prefix plus the path, nothing normalized away.
          expect(result.url).toBe(candidate);
          const parsed = new URL(result.url);
          expect(parsed.protocol).toBe('https:');
          expect(parsed.hostname).toBe('pkg.go.dev');
          expect(parsed.host).toBe('pkg.go.dev');
          expect(parsed.port).toBe('');
          expect(parsed.username).toBe('');
          expect(parsed.password).toBe('');
          expect(parsed.origin).toBe('https://pkg.go.dev');
        }),
        { numRuns: RUNS },
      );
    });

    it('never produces a URL that leaves https://pkg.go.dev, whatever the path starts with', () => {
      fc.assert(
        fc.property(hostilePathArb, anyStringArb, (hostile, tail) => {
          for (const path of [hostile, hostile + tail, tail + hostile]) {
            if (path === '') {
              continue;
            }
            const result = packagePageUrl(path);
            if (result.ok) {
              const parsed = new URL(result.url);
              expect(parsed.origin).toBe('https://pkg.go.dev');
              expect(parsed.username).toBe('');
              expect(parsed.password).toBe('');
              expect(parsed.port).toBe('');
              expect(result.url.startsWith(PREFIX)).toBe(true);
            }
          }
        }),
        { numRuns: RUNS },
      );
    });

    it('accepts every non-empty path, because the fixed prefix ends the authority', () => {
      fc.assert(
        fc.property(anyPathArb.filter((p) => p !== ''), (path) => {
          const result = packagePageUrl(path);
          expect(result).toEqual({ ok: true, url: PREFIX + path });
        }),
        { numRuns: RUNS },
      );
    });

    it('rejects the empty path', () => {
      expect(packagePageUrl('')).toEqual({ ok: false, reason: 'emptyPath' });
    });
  });

  describe('SearchController.open', () => {
    it('opens exactly the URL built from the displayed path, once, and leaves the state unchanged', async () => {
      await fc.assert(
        fc.asyncProperty(specsArb, fc.nat(), async (specs, n) => {
          const h = await harnessWithResults(specs);
          const { results, resultsVersion } = h.controller.state;
          const index = n % results.length;
          const path = results[index]!.path;
          const before = snapshot(h);

          await h.controller.open(resultsVersion, index);

          expect(h.opened).toEqual([PREFIX + path]);
          expect(isPkgGoDevHttpsUrl(h.opened[0]!)).toBe(true);
          expect(h.errors).toHaveLength(0);
          expect(h.output.lines).toHaveLength(before.logLines);
          expect(h.client.calls).toHaveLength(1);
          expectStateUnchanged(h, before);
        }),
        { numRuns: RUNS },
      );
    });

    it('ignores a stale resultsVersion without opening, logging, notifying, or changing state', async () => {
      await fc.assert(
        fc.asyncProperty(specsArb, fc.nat(), fc.integer({ min: -5, max: 5 }), async (specs, n, delta) => {
          const h = await harnessWithResults(specs);
          const { results, resultsVersion } = h.controller.state;
          const before = snapshot(h);
          const staleVersion = resultsVersion + (delta === 0 ? 1 : delta);

          await h.controller.open(staleVersion, n % results.length);

          expectNothingHappened(h, before, h.opened);
        }),
        { numRuns: RUNS },
      );
    });

    it('ignores an out-of-range or non-integer index without opening, logging, notifying, or changing state', async () => {
      await fc.assert(
        fc.asyncProperty(
          specsArb,
          fc.oneof(
            fc.nat({ max: 1000 }).map((extra) => ({ kind: 'beyond' as const, extra })),
            fc.integer({ min: -1000, max: -1 }).map((extra) => ({ kind: 'negative' as const, extra })),
            fc.double({ min: 0, max: 5, noInteger: true }).map((extra) => ({ kind: 'fraction' as const, extra })),
            fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY).map((extra) => ({
              kind: 'special' as const,
              extra,
            })),
          ),
          async (specs, bad) => {
            const h = await harnessWithResults(specs);
            const { results, resultsVersion } = h.controller.state;
            const before = snapshot(h);
            const index = bad.kind === 'beyond' ? results.length + bad.extra : bad.extra;

            await h.controller.open(resultsVersion, index);

            expectNothingHappened(h, before, h.opened);
          },
        ),
        { numRuns: RUNS },
      );
    });

    it('ignores any open before results exist', async () => {
      await fc.assert(
        fc.asyncProperty(fc.integer({ min: -3, max: 3 }), fc.integer({ min: -3, max: 3 }), async (version, index) => {
          const h = createControllerHarness();
          const before = snapshot(h);
          await h.controller.open(version, index);
          expectNothingHappened(h, before, h.opened);
        }),
        { numRuns: RUNS },
      );
    });

    it('never refuses a displayed path: parsed results always pass the allow-list', async () => {
      // A refusal needs an empty path, which the parser never emits; a refused path is therefore not reachable.
      await fc.assert(
        fc.asyncProperty(specsArb, async (specs) => {
          const h = await harnessWithResults(specs);
          for (const result of h.controller.state.results) {
            expect(result.path).not.toBe('');
            expect(packagePageUrl(result.path)).toEqual({ ok: true, url: PREFIX + result.path });
          }
        }),
        { numRuns: RUNS },
      );
    });

    it('reports one error notification and one log line when openExternal returns false', async () => {
      await fc.assert(
        fc.asyncProperty(specsArb, fc.nat(), async (specs, n) => {
          const calls: string[] = [];
          const h = await harnessWithResults(specs, {
            openExternal: (url) => {
              calls.push(url);
              return Promise.resolve(false);
            },
          });
          const { results, resultsVersion } = h.controller.state;
          const index = n % results.length;
          const path = results[index]!.path;
          const before = snapshot(h);

          await h.controller.open(resultsVersion, index);

          expect(calls).toEqual([PREFIX + path]);
          expect(h.errors).toEqual([`Could not open the pkg.go.dev page for ${path}.`]);
          expect(h.output.lines).toHaveLength(before.logLines + 1);
          const line = h.output.lines[before.logLines]!;
          expect(line.startsWith(`[${FIXED_TIMESTAMP}] Could not open package page for ${JSON.stringify(path)}: `)).toBe(true);
          expect(line).not.toMatch(/[\r\n]/);
          expectStateUnchanged(h, before);
        }),
        { numRuns: RUNS },
      );
    });

    it('reports one error notification and one log line when openExternal rejects', async () => {
      await fc.assert(
        fc.asyncProperty(specsArb, fc.nat(), fc.string({ maxLength: 20 }), async (specs, n, message) => {
          const calls: string[] = [];
          const h = await harnessWithResults(specs, {
            openExternal: (url) => {
              calls.push(url);
              return Promise.reject(new Error(message));
            },
          });
          const { results, resultsVersion } = h.controller.state;
          const index = n % results.length;
          const path = results[index]!.path;
          const before = snapshot(h);

          await h.controller.open(resultsVersion, index);

          expect(calls).toEqual([PREFIX + path]);
          expect(h.errors).toEqual([`Could not open the pkg.go.dev page for ${path}.`]);
          expect(h.output.lines).toHaveLength(before.logLines + 1);
          const line = h.output.lines[before.logLines]!;
          expect(line.startsWith(`[${FIXED_TIMESTAMP}] Could not open package page for ${JSON.stringify(path)}: `)).toBe(true);
          expect(line).not.toMatch(/[\r\n]/);
          expectStateUnchanged(h, before);
        }),
        { numRuns: RUNS },
      );
    });
  });
});
