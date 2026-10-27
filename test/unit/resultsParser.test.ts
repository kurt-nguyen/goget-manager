import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSearchResults } from '../../src/core/resultsParser';

const fixtureDir = resolve(__dirname, '..', 'fixtures', 'search-results');

function fixture(name: string): string {
  return readFileSync(resolve(fixtureDir, name), 'utf8');
}

describe('parseSearchResults with page fixtures', () => {
  const sample = fixture('sample.html');

  it('parses all 25 entries of the sample page (Req 3.1)', () => {
    expect(parseSearchResults(sample)).toHaveLength(25);
  });

  it('extracts every field of the first entry (Req 3.2, 3.3, 3.4)', () => {
    expect(parseSearchResults(sample)[0]).toEqual({
      path: 'go.mongodb.org/mongo-driver/v2/mongo',
      name: 'mongo',
      synopsis: 'Package mongo provides a MongoDB Driver API for Go.',
      version: 'v2.9.2',
      published: 'Oct 6, 2026',
      importedBy: '1,289',
    });
  });

  it('omits the synopsis for an entry without one (Req 3.5)', () => {
    const entry = parseSearchResults(sample).find((r) => r.path === 'github.com/kamva/mgm/v3');
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('synopsis');
    expect(entry).toMatchObject({
      name: 'mgm',
      version: 'v3.5.0',
      published: 'Sep 5, 2022',
      importedBy: '285',
    });
  });

  it('returns [] for an empty string (Req 3.7)', () => {
    expect(parseSearchResults('')).toEqual([]);
  });

  it('returns [] for a page with no results (Req 3.7)', () => {
    expect(parseSearchResults(fixture('no-results.html'))).toEqual([]);
  });

  it('keeps the entries before an unterminated tag and drops the broken one (Req 3.8)', () => {
    const paths = parseSearchResults(fixture('unterminated.html')).map((r) => r.path);
    const expected = parseSearchResults(sample)
      .slice(0, 2)
      .map((r) => r.path);
    expect(expected).toEqual(['go.mongodb.org/mongo-driver/v2/mongo', 'gopkg.in/mgo.v2']);
    expect(paths).toEqual(expected);
  });

  it('collapses whitespace runs in the published date (Req 3.4)', () => {
    const html = fixture('sample.html');
    expect(html).toContain('<strong>Oct  6, 2026</strong>');
    expect(parseSearchResults(html)[0]?.published).toBe('Oct 6, 2026');
  });

  it('parses a synthetic 5 MB page in under 1 s (Req 3.1)', () => {
    const target = 5 * 1024 * 1024;
    const copies = Math.ceil(target / sample.length);
    const page = sample.repeat(copies);
    expect(page.length).toBeGreaterThanOrEqual(target);

    const startedAt = performance.now();
    const results = parseSearchResults(page);
    const elapsed = performance.now() - startedAt;

    expect(results).toHaveLength(25 * copies);
    expect(elapsed).toBeLessThan(1000);
  });
});
