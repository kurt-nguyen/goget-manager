import { describe, expect, it } from 'vitest';
import type { FolderGoModState, InstalledSnapshot } from '../../src/core/installedModel';
import { collectInstalledModulePaths, findInstalledModule, isInstallablePath, isInstalledPackage } from '../../src/core/installedMatch';

function parsed(name: string, deps: Array<[string, string]>): FolderGoModState {
  return {
    kind: 'parsed',
    folderUri: `file:///${name}`,
    folderName: name,
    goModPath: `/${name}/go.mod`,
    modulePath: `example.com/${name}`,
    dependencies: deps.map(([path, version]) => ({ path, version })),
  };
}

describe('collectInstalledModulePaths', () => {
  it('returns an empty list for an empty snapshot', () => {
    expect(collectInstalledModulePaths({ folders: [] })).toEqual([]);
  });

  it('collects only parsed folders', () => {
    const snapshot: InstalledSnapshot = {
      folders: [
        { kind: 'absent', folderUri: 'file:///a', folderName: 'a' },
        {
          kind: 'parseError',
          folderUri: 'file:///b',
          folderName: 'b',
          goModPath: '/b/go.mod',
          error: { line: 1, message: 'bad' },
        },
        { kind: 'readError', folderUri: 'file:///c', folderName: 'c', goModPath: '/c/go.mod', reason: 'EACCES' },
        parsed('d', [['github.com/x/y', 'v1.0.0']]),
      ],
    };
    expect(collectInstalledModulePaths(snapshot)).toEqual(['github.com/x/y']);
  });

  it('deduplicates paths across folders with different versions and sorts by code point', () => {
    const snapshot: InstalledSnapshot = {
      folders: [
        parsed('one', [
          ['github.com/b/b', 'v1.0.0'],
          ['github.com/a/a', 'v1.0.0'],
        ]),
        parsed('two', [['github.com/b/b', 'v2.0.0']]),
      ],
    };
    expect(collectInstalledModulePaths(snapshot)).toEqual(['github.com/a/a', 'github.com/b/b']);
  });
});

describe('isInstalledPackage', () => {
  const set = (...paths: string[]): ReadonlySet<string> => new Set(paths);

  it('matches an exact module path', () => {
    expect(isInstalledPackage('github.com/x/y', set('github.com/x/y'))).toBe(true);
  });

  it('matches a package inside an installed module', () => {
    expect(isInstalledPackage('github.com/x/y/sub/pkg', set('github.com/x/y'))).toBe(true);
  });

  it('does not match on a partial path segment or a parent path', () => {
    expect(isInstalledPackage('github.com/x/yy', set('github.com/x/y'))).toBe(false);
    expect(isInstalledPackage('github.com/x', set('github.com/x/y'))).toBe(false);
  });

  it('treats a major version suffix as a different module', () => {
    const installed = set('github.com/x/y');
    expect(isInstalledPackage('github.com/x/y/v2', installed)).toBe(false);
    expect(isInstalledPackage('github.com/x/y/v2/sub', installed)).toBe(false);
    expect(isInstalledPackage('github.com/x/y/v10/z', installed)).toBe(false);
  });

  it('matches major version paths when that module is installed', () => {
    const installed = set('github.com/x/y/v2');
    expect(isInstalledPackage('github.com/x/y/v2', installed)).toBe(true);
    expect(isInstalledPackage('github.com/x/y/v2/sub', installed)).toBe(true);
  });

  it('does not treat non-version segments as a major version', () => {
    const installed = set('github.com/x/y');
    expect(isInstalledPackage('github.com/x/y/vendor/z', installed)).toBe(true);
    expect(isInstalledPackage('github.com/x/y/v1/z', installed)).toBe(true);
  });

  it('compares gopkg.in paths exactly', () => {
    const installed = set('gopkg.in/yaml.v3');
    expect(isInstalledPackage('gopkg.in/yaml.v3', installed)).toBe(true);
    expect(isInstalledPackage('gopkg.in/yaml.v2', installed)).toBe(false);
  });

  it('is case-sensitive', () => {
    expect(isInstalledPackage('github.com/X/Y', set('github.com/x/y'))).toBe(false);
  });

  it('is false for an empty set and for standard library paths', () => {
    expect(isInstalledPackage('github.com/x/y', set())).toBe(false);
    expect(isInstalledPackage('net/http', set('github.com/x/y'))).toBe(false);
  });
});

describe('findInstalledModule', () => {
  const set = (...paths: string[]): ReadonlySet<string> => new Set(paths);
  it('returns the exact path and the parent module of a sub-package', () => {
    expect(findInstalledModule('github.com/spf13/cobra', set('github.com/spf13/cobra'))).toBe('github.com/spf13/cobra');
    expect(findInstalledModule('github.com/spf13/cobra/doc', set('github.com/spf13/cobra'))).toBe('github.com/spf13/cobra');
  });
  it('prefers the longer module and respects major version suffixes', () => {
    expect(findInstalledModule('github.com/x/m/v2/sub', set('github.com/x/m', 'github.com/x/m/v2'))).toBe('github.com/x/m/v2');
    expect(findInstalledModule('github.com/x/m/v2/sub', set('github.com/x/m'))).toBeUndefined();
  });
  it('does not match on a partial segment', () => {
    expect(findInstalledModule('github.com/x/yy', set('github.com/x/y'))).toBeUndefined();
  });
});

describe('isInstallablePath', () => {
  it('accepts domain paths and rejects standard library, flags and empty', () => {
    expect(isInstallablePath('github.com/spf13/cobra')).toBe(true);
    expect(isInstallablePath('gopkg.in/yaml.v3')).toBe(true);
    expect(isInstallablePath('os')).toBe(false);
    expect(isInstallablePath('net/http')).toBe(false);
    expect(isInstallablePath('-x.y/z')).toBe(false);
    expect(isInstallablePath('')).toBe(false);
  });
});
