import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseSearchResults } from '../../../src/core/resultsParser';
import {
  anyEntrySpecArb,
  expectedPageResults,
  invalidEntrySpecArb,
  isValidEntrySpec,
  pageModelArb,
  renderPage,
  type PageModel,
} from '../searchArbitraries';

const RUNS = 200;

describe('Property 4', () => {
  // Feature: search-packages, Property 4: Invalid entries are dropped without disturbing the rest
  // **Validates: Requirements 3.6**
  it('drops entries without a usable path or name and returns the valid ones unchanged, in page order', () => {
    fc.assert(
      fc.property(pageModelArb({ specArb: anyEntrySpecArb }), (page) => {
        const actual = parseSearchResults(renderPage(page));
        expect(actual).toEqual(expectedPageResults(page));

        const validCount = page.entries.filter((entry) => isValidEntrySpec(entry.spec)).length;
        expect(actual).toHaveLength(validCount);
      }),
      { numRuns: RUNS },
    );
  });

  it('returns the same results as the page with the invalid entries removed', () => {
    fc.assert(
      fc.property(pageModelArb({ specArb: anyEntrySpecArb }), (page) => {
        const validOnly: PageModel = {
          ...page,
          entries: page.entries.filter((entry) => isValidEntrySpec(entry.spec)),
        };
        expect(parseSearchResults(renderPage(page))).toEqual(parseSearchResults(renderPage(validOnly)));
      }),
      { numRuns: RUNS },
    );
  });

  it('returns no results for a page of only invalid entries', () => {
    fc.assert(
      fc.property(pageModelArb({ specArb: invalidEntrySpecArb, minEntries: 1 }), (page) => {
        for (const entry of page.entries) {
          expect(isValidEntrySpec(entry.spec)).toBe(false);
        }
        expect(parseSearchResults(renderPage(page))).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });
});
