import { describe, expect, it } from 'vitest';
import {
  SEARCHING,
  TIMED_OUT,
  UNREACHABLE,
  httpError,
  noResults,
  openFailedLog,
  openFailedNotification,
  openRefusedLog,
  resultCount,
  searchFailureLog,
} from '../../src/core/messages';
import { MAX_SYNOPSIS, toResultEntry, truncateSynopsis } from '../../src/core/resultView';
import { parseWebviewMessage } from '../../src/core/searchProtocol';

const TS = '2026-01-02T03:04:05.000Z';

describe('search status texts', () => {
  it('uses the exact fixed texts', () => {
    expect(SEARCHING).toBe('Searching\u2026');
    expect(UNREACHABLE).toBe('Could not reach pkg.go.dev. Check your internet connection and try again.');
    expect(TIMED_OUT).toBe('The search timed out. Try again.');
  });

  it('pluralizes resultCount', () => {
    expect(resultCount(1)).toBe('1 result');
    expect(resultCount(2)).toBe('2 results');
    expect(resultCount(25)).toBe('25 results');
  });

  it('formats noResults, httpError, and openFailedNotification', () => {
    expect(noResults('mongodb')).toBe('No packages found for "mongodb".');
    expect(httpError(503)).toBe('pkg.go.dev returned an error (HTTP 503). Try again later.');
    expect(openFailedNotification('github.com/a/b')).toBe(
      'Could not open the pkg.go.dev page for github.com/a/b.',
    );
  });
});

describe('search log lines', () => {
  it('formats an unreachable failure', () => {
    expect(searchFailureLog(TS, 'mongo', { kind: 'unreachable', reason: 'ENOTFOUND' })).toBe(
      `[${TS}] Search for "mongo" failed: unreachable (ENOTFOUND)`,
    );
  });

  it('formats an HTTP failure', () => {
    expect(searchFailureLog(TS, 'mongo', { kind: 'http', status: 500 })).toBe(
      `[${TS}] Search for "mongo" failed: HTTP error 500`,
    );
  });

  it('formats a blocked redirect with status and target host', () => {
    expect(
      searchFailureLog(TS, 'mongo', { kind: 'redirectBlocked', status: 302, targetHost: 'evil.example' }),
    ).toBe(`[${TS}] Search for "mongo" failed: HTTP error 302, redirect to host evil.example blocked`);
  });

  it('formats a timeout', () => {
    expect(searchFailureLog(TS, 'mongo', { kind: 'timeout' })).toBe(
      `[${TS}] Search for "mongo" failed: timeout after 10 s`,
    );
  });

  it('keeps a query with quotes and newlines on one line', () => {
    const line = searchFailureLog(TS, 'a"b\nc\r\nd', { kind: 'http', status: 500 });
    expect(line).toBe(`[${TS}] Search for "a\\"b\\nc\\r\\nd" failed: HTTP error 500`);
    expect(line).not.toMatch(/[\r\n]/);
  });

  it('keeps reason and host on one line', () => {
    const unreachable = searchFailureLog(TS, 'q', { kind: 'unreachable', reason: 'a\nb\r\nc' });
    const blocked = searchFailureLog(TS, 'q', {
      kind: 'redirectBlocked',
      status: 301,
      targetHost: 'x\ny',
    });
    expect(unreachable).toBe(`[${TS}] Search for "q" failed: unreachable (a b c)`);
    expect(blocked).not.toMatch(/[\r\n]/);
  });

  it('formats open refused lines', () => {
    expect(openRefusedLog(TS, '', 'emptyPath')).toBe(
      `[${TS}] Did not open package page for "": empty package path`,
    );
    expect(openRefusedLog(TS, 'a/b', 'notPkgGoDev')).toBe(
      `[${TS}] Did not open package page for "a/b": not an HTTPS pkg.go.dev URL`,
    );
  });

  it('formats the open failed line on one line', () => {
    expect(openFailedLog(TS, 'a/b', 'boom')).toBe(`[${TS}] Could not open package page for "a/b": boom`);
    expect(openFailedLog(TS, 'a"\nb', 'x\ny')).not.toMatch(/[\r\n]/);
  });
});

describe('truncateSynopsis', () => {
  it('leaves 299 and 300 code points unchanged', () => {
    expect(truncateSynopsis('a'.repeat(299))).toBe('a'.repeat(299));
    expect(truncateSynopsis('a'.repeat(300))).toBe('a'.repeat(300));
  });

  it('truncates 301 code points to 300 plus an ellipsis', () => {
    expect(truncateSynopsis('a'.repeat(301))).toBe(`${'a'.repeat(300)}\u2026`);
  });

  it('does not split an astral character at the boundary', () => {
    const astral = '\u{1F600}';
    // 300 code points ending in an astral character: unchanged.
    const exact = 'a'.repeat(299) + astral;
    expect(truncateSynopsis(exact)).toBe(exact);
    // 301 code points where the 300th is astral: the pair stays whole.
    const over = 'a'.repeat(299) + astral + 'b';
    expect(truncateSynopsis(over)).toBe(`${'a'.repeat(299)}${astral}\u2026`);
    // 301 code points where the 301st is astral.
    const overAstral = 'a'.repeat(300) + astral;
    expect(truncateSynopsis(overAstral)).toBe(`${'a'.repeat(300)}\u2026`);
  });

  it('uses 300 as the default maximum', () => {
    expect(MAX_SYNOPSIS).toBe(300);
  });
});

describe('toResultEntry', () => {
  it('omits absent optional fields', () => {
    const entry = toResultEntry({ path: 'a/b', name: 'b' });
    expect(entry).toEqual({ path: 'a/b', name: 'b' });
    expect(Object.keys(entry).sort()).toEqual(['name', 'path']);
  });

  it('copies present fields and truncates the synopsis', () => {
    const entry = toResultEntry({
      path: 'a/b',
      name: 'b',
      synopsis: 'x'.repeat(301),
      version: 'v1.0.0',
      published: 'Oct 6, 2026',
      importedBy: '1,289',
    });
    expect(entry).toEqual({
      path: 'a/b',
      name: 'b',
      synopsis: `${'x'.repeat(300)}\u2026`,
      version: 'v1.0.0',
      published: 'Oct 6, 2026',
      importedBy: '1,289',
    });
  });
});

describe('parseWebviewMessage', () => {
  it('accepts valid messages', () => {
    expect(parseWebviewMessage({ type: 'ready' })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'query', text: 'abc' })).toEqual({ type: 'query', text: 'abc' });
    expect(parseWebviewMessage({ type: 'submit', text: '' })).toEqual({ type: 'submit', text: '' });
    expect(parseWebviewMessage({ type: 'open', resultsVersion: 3, index: 0 })).toEqual({
      type: 'open',
      resultsVersion: 3,
      index: 0,
    });
  });

  it('rejects unknown types', () => {
    expect(parseWebviewMessage({ type: 'nope' })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'state', state: {} })).toBeUndefined();
    expect(parseWebviewMessage({})).toBeUndefined();
    expect(parseWebviewMessage({ type: 1 })).toBeUndefined();
  });

  it('rejects non-string text', () => {
    expect(parseWebviewMessage({ type: 'query', text: 5 })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'submit', text: null })).toBeUndefined();
    expect(parseWebviewMessage({ type: 'query' })).toBeUndefined();
  });

  it('rejects negative, fractional, and non-finite numbers', () => {
    for (const bad of [-1, 1.5, NaN, Infinity, '1', null, undefined]) {
      expect(parseWebviewMessage({ type: 'open', resultsVersion: bad, index: 0 })).toBeUndefined();
      expect(parseWebviewMessage({ type: 'open', resultsVersion: 0, index: bad })).toBeUndefined();
    }
  });

  it('rejects non-objects', () => {
    for (const bad of [null, undefined, 'ready', 42, true, ['ready'], []]) {
      expect(parseWebviewMessage(bad)).toBeUndefined();
    }
  });

  it('clamps text to 256 code points', () => {
    const astral = '\u{1F600}';
    const text = astral.repeat(300);
    const parsed = parseWebviewMessage({ type: 'query', text });
    expect(parsed).toEqual({ type: 'query', text: astral.repeat(256) });
  });

  it('drops extra keys', () => {
    expect(parseWebviewMessage({ type: 'ready', url: 'https://x', extra: 1 })).toEqual({ type: 'ready' });
    expect(parseWebviewMessage({ type: 'submit', text: 'a', url: 'x' })).toEqual({ type: 'submit', text: 'a' });
    expect(
      parseWebviewMessage({ type: 'open', resultsVersion: 1, index: 2, path: 'x/y' }),
    ).toEqual({ type: 'open', resultsVersion: 1, index: 2 });
  });
});
