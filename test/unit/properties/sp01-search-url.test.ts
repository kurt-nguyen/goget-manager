import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildSearchUrl } from '../../../src/core/searchQuery';
import { queryArb as query } from '../searchArbitraries';

const RUNS = 200;

const codePointCount = (s: string): number => Array.from(s).length;

// Percent-decodes `%XX` sequences as UTF-8 bytes; any other character must be plain ASCII.
function percentDecode(raw: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw.charAt(i);
    if (ch === '%') {
      const hex = raw.slice(i + 1, i + 3);
      expect(hex).toMatch(/^[0-9A-Fa-f]{2}$/);
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      expect(raw.charCodeAt(i)).toBeLessThan(0x80);
      bytes.push(raw.charCodeAt(i));
    }
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bytes));
}

describe('Property 1', () => {
  // Feature: search-packages, Property 1: Search URL structure and query round trip
  // **Validates: Requirements 2.1, 2.3, 2.4**
  it('builds an https://pkg.go.dev/search URL with exactly q and m, and q decodes back to the query', () => {
    fc.assert(
      fc.property(query, (q) => {
        expect(codePointCount(q)).toBeGreaterThanOrEqual(1);
        expect(codePointCount(q)).toBeLessThanOrEqual(256);

        const result = buildSearchUrl(q);
        expect(result.ok).toBe(true);
        if (!result.ok) {
          return;
        }

        // Structure (Requirement 2.1).
        const parsed = new URL(result.url);
        expect(parsed.protocol).toBe('https:');
        expect(parsed.hostname).toBe('pkg.go.dev');
        expect(parsed.port).toBe('');
        expect(parsed.username).toBe('');
        expect(parsed.password).toBe('');
        expect(parsed.pathname).toBe('/search');
        expect(parsed.hash).toBe('');

        // Exactly two parameters, q then m, with m=package (Requirements 2.1, 2.4).
        expect(parsed.search.startsWith('?')).toBe(true);
        const params = parsed.search.slice(1).split('&');
        expect(params).toHaveLength(2);
        const [qParam, mParam] = params as [string, string];
        expect(qParam.startsWith('q=')).toBe(true);
        expect(mParam).toBe('m=package');
        expect(parsed.searchParams.getAll('q')).toHaveLength(1);
        expect(parsed.searchParams.getAll('m')).toEqual(['package']);
        expect([...parsed.searchParams.keys()]).toEqual(['q', 'm']);

        // The raw q value cannot contain characters that would add or alter parameters.
        const rawQ = qParam.slice(2);
        expect(rawQ).not.toMatch(/[&=#+?/ ]/);

        // Round trip (Requirement 2.3).
        expect(percentDecode(rawQ)).toBe(q);
      }),
      { numRuns: RUNS },
    );
  });

  it('round-trips a query made only of reserved characters', () => {
    const q = '&=#+%?/ !\'()*';
    const result = buildSearchUrl(q);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const rawQ = new URL(result.url).search.slice(1).split('&')[0]!.slice(2);
      expect(percentDecode(rawQ)).toBe(q);
    }
  });
});
