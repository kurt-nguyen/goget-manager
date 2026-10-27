import { describe, expect, it } from 'vitest';
import { EMPTY_DETAIL_STATE, parseDetailMessage } from '../../src/core/detailProtocol';

describe('EMPTY_DETAIL_STATE', () => {
  it('is idle with no path', () => {
    expect(EMPTY_DETAIL_STATE).toEqual({ status: 'idle', path: '', installed: false, mainLoading: false });
  });
});

describe('parseDetailMessage', () => {
  it('accepts the argument-less messages and drops extra keys', () => {
    for (const type of ['ready', 'retry', 'install', 'uninstall']) {
      expect(parseDetailMessage({ type })).toEqual({ type });
      expect(parseDetailMessage({ type, extra: 1, url: 'https://x' })).toEqual({ type });
    }
  });

  it('accepts changeGoos with a lower-case alphanumeric GOOS of 1..16 chars', () => {
    expect(parseDetailMessage({ type: 'changeGoos', goos: 'windows' })).toEqual({ type: 'changeGoos', goos: 'windows' });
    expect(parseDetailMessage({ type: 'changeGoos', goos: 'a'.repeat(16), x: 1 })).toEqual({
      type: 'changeGoos',
      goos: 'a'.repeat(16),
    });
  });

  it('rejects changeGoos with an invalid GOOS', () => {
    for (const goos of ['Win dows', '', 'a'.repeat(17), 'Linux', 'a-b', 'a/b', 5, null, undefined]) {
      expect(parseDetailMessage({ type: 'changeGoos', goos })).toBeUndefined();
    }
    expect(parseDetailMessage({ type: 'changeGoos' })).toBeUndefined();
  });

  it('accepts openLink for http, https and mailto and returns the normalised href', () => {
    expect(parseDetailMessage({ type: 'openLink', url: 'https://go.dev/doc' })).toEqual({
      type: 'openLink',
      url: 'https://go.dev/doc',
    });
    expect(parseDetailMessage({ type: 'openLink', url: 'http://example.com' })).toEqual({
      type: 'openLink',
      url: 'http://example.com/',
    });
    expect(parseDetailMessage({ type: 'openLink', url: 'mailto:a@b.c', extra: 1 })).toEqual({
      type: 'openLink',
      url: 'mailto:a@b.c',
    });
  });

  it('rejects openLink with other schemes, non-strings, unparseable or oversized urls', () => {
    const bad: unknown[] = [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,x',
      'vscode://x/y',
      '/relative',
      '',
      'https://example.com/' + 'a'.repeat(2048),
      5,
      null,
      undefined,
      {},
    ];
    for (const url of bad) {
      expect(parseDetailMessage({ type: 'openLink', url })).toBeUndefined();
    }
    expect(parseDetailMessage({ type: 'openLink' })).toBeUndefined();
  });

  it('rejects unknown types and non-objects', () => {
    for (const bad of [undefined, null, 42, 'ready', true, [], ['ready'], {}, { type: 'nope' }, { type: 1 }, { type: 'state' }]) {
      expect(parseDetailMessage(bad)).toBeUndefined();
    }
  });

  it('returns undefined instead of throwing when a getter throws', () => {
    const value = {
      get type(): string {
        throw new Error('boom');
      },
    };
    expect(parseDetailMessage(value)).toBeUndefined();
    const goos = {
      type: 'changeGoos',
      get goos(): string {
        throw new Error('boom');
      },
    };
    expect(parseDetailMessage(goos)).toBeUndefined();
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    expect(parseDetailMessage(revoked.proxy)).toBeUndefined();
  });
});
