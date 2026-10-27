import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseSearchResults } from '../../../src/core/resultsParser';
import {
  entryModelArb,
  expectedPageResults,
  pageModelArb,
  plainPage,
  renderPage,
  validEntrySpecArb,
  type PageModel,
} from '../searchArbitraries';

const RUNS = 200;

// Pages in which at least one path appears on two entries, with different names, fields, and noise.
const pageWithDuplicatePathsArb: fc.Arbitrary<{ page: PageModel; source: number; at: number }> = fc
  .tuple(pageModelArb({ minEntries: 1 }), entryModelArb(validEntrySpecArb), fc.nat(), fc.nat())
  .map(([page, other, sourcePick, atPick]) => {
    const source = sourcePick % page.entries.length;
    const copy = {
      spec: { ...other.spec, path: page.entries[source]!.spec.path },
      noise: other.noise,
    };
    const at = atPick % (page.entries.length + 1);
    const entries = [...page.entries.slice(0, at), copy, ...page.entries.slice(at)];
    return { page: { ...page, entries }, source: source < at ? source : source + 1, at };
  });

describe('Property 3', () => {
  // Feature: search-packages, Property 3: Parsing a rendered results page returns its entries
  // **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
  it('returns exactly the rendered entries, in page order, with normalized fields and optional fields omitted when empty', () => {
    fc.assert(
      fc.property(pageModelArb({ minEntries: 1 }), (page) => {
        const expected = expectedPageResults(page);
        expect(expected.length).toBeGreaterThanOrEqual(1);
        const actual = parseSearchResults(renderPage(page));
        expect(actual).toEqual(expected);
        for (const result of actual) {
          // Absent optional fields are omitted, not empty strings (Requirement 3.3).
          for (const value of Object.values(result)) {
            expect(value).not.toBe('');
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('keeps entries that share a package path, in page order', () => {
    fc.assert(
      fc.property(pageWithDuplicatePathsArb, ({ page, source, at }) => {
        const expected = expectedPageResults(page);
        const actual = parseSearchResults(renderPage(page));
        expect(actual).toEqual(expected);
        expect(actual).toHaveLength(page.entries.length);

        const sharedPath = expected[source]!.path;
        expect(expected[at]!.path).toBe(sharedPath);
        expect(actual.filter((r) => r.path === sharedPath).length).toBeGreaterThanOrEqual(2);
      }),
      { numRuns: RUNS },
    );
  });

  it('returns identical entries twice when the same entry appears twice', () => {
    fc.assert(
      fc.property(validEntrySpecArb, (spec) => {
        const actual = parseSearchResults(renderPage(plainPage([spec, spec])));
        expect(actual).toHaveLength(2);
        expect(actual[0]).toEqual(actual[1]);
      }),
      { numRuns: RUNS },
    );
  });
});
