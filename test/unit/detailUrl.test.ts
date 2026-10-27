import { describe, expect, it } from 'vitest';
import { isValidImportPath, packageDetailUrl } from '../../src/core/detailUrl';

describe('isValidImportPath', () => {
  it.each(['os', 'net/http', 'github.com/pkg/sftp/v2', 'gopkg.in/yaml.v3', 'golang.org/x/sys/unix', 'a~b/c+d_e-f'])(
    'accepts %s',
    (path) => {
      expect(isValidImportPath(path)).toBe(true);
    },
  );

  it.each([
    '',
    '..',
    '.',
    'a/../b',
    'a/./b',
    'a//b',
    '/a',
    'a/',
    'a b',
    'a?x',
    'a#x',
    'a@v1',
    'a%2Fb',
    'a\\b',
    'a:b',
    'é',
  ])('rejects %j', (path) => {
    expect(isValidImportPath(path)).toBe(false);
  });

  it('enforces the 512 character limit', () => {
    expect(isValidImportPath('a'.repeat(512))).toBe(true);
    expect(isValidImportPath('a'.repeat(513))).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isValidImportPath(undefined as unknown as string)).toBe(false);
    expect(isValidImportPath(5 as unknown as string)).toBe(false);
  });
});

describe('packageDetailUrl', () => {
  it('builds the plain page URL', () => {
    expect(packageDetailUrl('github.com/pkg/sftp/v2')).toEqual({
      ok: true,
      url: 'https://pkg.go.dev/github.com/pkg/sftp/v2',
    });
  });

  it('appends GOOS when valid', () => {
    expect(packageDetailUrl('os', 'windows')).toEqual({ ok: true, url: 'https://pkg.go.dev/os?GOOS=windows' });
    expect(packageDetailUrl('os', 'js')).toEqual({ ok: true, url: 'https://pkg.go.dev/os?GOOS=js' });
  });

  it.each(['', 'Windows', 'win dows', 'a'.repeat(17), 'linux&x=1', 'linux#x', '../x'])('rejects GOOS %j', (goos) => {
    expect(packageDetailUrl('os', goos)).toEqual({ ok: false, reason: 'invalidGoos' });
  });

  it('rejects invalid paths first', () => {
    expect(packageDetailUrl('a/../b')).toEqual({ ok: false, reason: 'invalidPath' });
    expect(packageDetailUrl('a b', 'linux')).toEqual({ ok: false, reason: 'invalidPath' });
    expect(packageDetailUrl('')).toEqual({ ok: false, reason: 'invalidPath' });
  });
});
