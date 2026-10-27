import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseSearchResults, type PackageResult } from '../../../src/core/resultsParser';
import { pageModelArb, renderPage } from '../searchArbitraries';

const RUNS = 200;

const garbageArb = fc.string({ unit: 'binary', maxLength: 400 });

/** Every result has a non-empty, whitespace-free path, a non-empty name, and no empty optional field. */
function expectWellFormed(results: readonly PackageResult[]): void {
  expect(Array.isArray(results)).toBe(true);
  for (const result of results) {
    expect(typeof result.path).toBe('string');
    expect(result.path).not.toBe('');
    expect(result.path).not.toMatch(/\s/u);
    expect(typeof result.name).toBe('string');
    expect(result.name).not.toBe('');
    for (const key of ['synopsis', 'version', 'published', 'importedBy'] as const) {
      if (key in result) {
        expect(typeof result[key]).toBe('string');
        expect(result[key]).not.toBe('');
      }
    }
  }
}

function expectPrefix(prefix: readonly string[], whole: readonly string[]): void {
  expect(prefix.length).toBeLessThanOrEqual(whole.length);
  expect(prefix).toEqual(whole.slice(0, prefix.length));
}

describe('Property 5', () => {
  // Feature: search-packages, Property 5: The parser is total and its output is well formed on any input
  // **Validates: Requirements 3.7, 3.8, 3.9**
  it('never throws on arbitrary text and returns only well-formed results', () => {
    fc.assert(
      fc.property(garbageArb, (text) => {
        expectWellFormed(parseSearchResults(text));
      }),
      { numRuns: RUNS },
    );
  });

  it('never throws on arbitrary text mixed with markup fragments', () => {
    const fragmentArb = fc.constantFrom(
      '<div class="SearchSnippet">',
      '<h2>',
      '<a data-test-id="snippet-title" href="x">',
      '<span class="SearchSnippet-header-path">(a/b)',
      '</span>',
      '</a>',
      '</div>',
      '<strong>',
      '<!--',
      '<script>',
      '<',
      '"',
      '&#x110000;',
    );
    fc.assert(
      fc.property(
        fc.array(fc.oneof(garbageArb, fragmentArb), { maxLength: 30 }).map((parts) => parts.join('')),
        (text) => {
          expectWellFormed(parseSearchResults(text));
        },
      ),
      { numRuns: RUNS },
    );
  });

  it('on a rendered page cut at any offset, returns a prefix of the uncut page paths', () => {
    fc.assert(
      fc.property(pageModelArb({ minEntries: 1 }), fc.array(fc.nat(), { minLength: 1, maxLength: 8 }), (page, offsets) => {
        const html = renderPage(page);
        const full = parseSearchResults(html);
        expectWellFormed(full);
        const fullPaths = full.map((r) => r.path);
        for (const offset of offsets) {
          const cut = offset % (html.length + 1);
          const partial = parseSearchResults(html.slice(0, cut));
          expectWellFormed(partial);
          expectPrefix(
            partial.map((r) => r.path),
            fullPaths,
          );
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('keeps results well formed when rendered pages are concatenated with garbage', () => {
    fc.assert(
      fc.property(
        pageModelArb(),
        pageModelArb(),
        garbageArb,
        garbageArb,
        garbageArb,
        fc.nat(),
        (first, second, before, between, after, offset) => {
          const text = before + renderPage(first) + between + renderPage(second) + after;
          expectWellFormed(parseSearchResults(text));
          const cut = offset % (text.length + 1);
          expectWellFormed(parseSearchResults(text.slice(0, cut)));
          expectWellFormed(parseSearchResults(text.slice(cut)));
        },
      ),
      { numRuns: RUNS },
    );
  });
});
