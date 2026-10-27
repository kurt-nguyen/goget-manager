import { describe, expect, it } from 'vitest';
import {
  buildSearchUrl,
  encodeQueryComponent,
  isPkgGoDevHttpsUrl,
  packagePageUrl,
  toSearchQuery,
} from '../../src/core/searchQuery';

describe('buildSearchUrl', () => {
  it('returns empty for the empty query', () => {
    expect(buildSearchUrl('')).toEqual({ ok: false, reason: 'empty' });
  });

  it('builds the pkg.go.dev package search URL', () => {
    expect(buildSearchUrl('mongodb')).toEqual({
      ok: true,
      url: 'https://pkg.go.dev/search?q=mongodb&m=package',
    });
  });

  it('percent-encodes reserved characters with uppercase hex', () => {
    expect(buildSearchUrl('a b+c&d=e#f')).toEqual({
      ok: true,
      url: 'https://pkg.go.dev/search?q=a%20b%2Bc%26d%3De%23f&m=package',
    });
  });

  it('encodes a lone surrogate as U+FFFD (%EF%BF%BD)', () => {
    expect(encodeQueryComponent('\ud800')).toBe('%EF%BF%BD');
    expect(encodeQueryComponent('a\udc00b')).toBe('a%EF%BF%BDb');
    expect(buildSearchUrl('\ud800')).toEqual({
      ok: true,
      url: 'https://pkg.go.dev/search?q=%EF%BF%BD&m=package',
    });
  });

  it('encodes astral characters as a single 4-byte UTF-8 sequence', () => {
    expect(encodeQueryComponent('\u{1F600}')).toBe('%F0%9F%98%80');
  });

  it('keeps unreserved characters literal', () => {
    expect(encodeQueryComponent('Az09-._~')).toBe('Az09-._~');
  });
});

describe('toSearchQuery', () => {
  it('trims surrounding whitespace', () => {
    expect(toSearchQuery('  mongo db \t\n')).toBe('mongo db');
  });

  it('returns the empty string for whitespace-only text', () => {
    expect(toSearchQuery('   ')).toBe('');
  });

  it('clamps to 256 code points', () => {
    expect(toSearchQuery('a'.repeat(300))).toBe('a'.repeat(256));
    const astral = '\u{1F600}'.repeat(300);
    expect(toSearchQuery(astral)).toBe('\u{1F600}'.repeat(256));
  });

  it('clamps before trimming', () => {
    expect(toSearchQuery('a'.repeat(255) + ' b')).toBe('a'.repeat(255));
  });
});

describe('isPkgGoDevHttpsUrl', () => {
  it('accepts https pkg.go.dev URLs, with or without the default port', () => {
    expect(isPkgGoDevHttpsUrl('https://pkg.go.dev/search?q=x&m=package')).toBe(true);
    expect(isPkgGoDevHttpsUrl('https://pkg.go.dev:443/x')).toBe(true);
  });

  it('rejects http:', () => {
    expect(isPkgGoDevHttpsUrl('http://pkg.go.dev/x')).toBe(false);
  });

  it('rejects a non-default port', () => {
    expect(isPkgGoDevHttpsUrl('https://pkg.go.dev:8443/x')).toBe(false);
  });

  it('rejects credentials', () => {
    expect(isPkgGoDevHttpsUrl('https://user@pkg.go.dev/x')).toBe(false);
    expect(isPkgGoDevHttpsUrl('https://user:pass@pkg.go.dev/x')).toBe(false);
  });

  it('rejects look-alike hosts', () => {
    expect(isPkgGoDevHttpsUrl('https://pkg.go.dev.evil.com/x')).toBe(false);
    expect(isPkgGoDevHttpsUrl('https://evilpkg.go.dev/x')).toBe(false);
  });

  it('rejects unparsable input without throwing', () => {
    expect(isPkgGoDevHttpsUrl('')).toBe(false);
    expect(isPkgGoDevHttpsUrl('not a url')).toBe(false);
    expect(isPkgGoDevHttpsUrl('//pkg.go.dev/x')).toBe(false);
  });
});

describe('packagePageUrl', () => {
  it('returns emptyPath for the empty path', () => {
    expect(packagePageUrl('')).toEqual({ ok: false, reason: 'emptyPath' });
  });

  it('builds the package page URL from the displayed path', () => {
    expect(packagePageUrl('go.mongodb.org/mongo-driver/v2/mongo')).toEqual({
      ok: true,
      url: 'https://pkg.go.dev/go.mongodb.org/mongo-driver/v2/mongo',
    });
  });
});
