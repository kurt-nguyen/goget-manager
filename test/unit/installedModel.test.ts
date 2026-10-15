import { describe, expect, it } from 'vitest';
import { buildInstalledTree, type FolderGoModState } from '../../src/core/installedModel';
import { parseGoMod } from '../../src/core/goModParser';
import * as messages from '../../src/core/messages';

const absent = (name: string): FolderGoModState => ({
  kind: 'absent',
  folderUri: `file:///ws/${name}`,
  folderName: name,
});

const parsed = (
  name: string,
  deps: Array<[string, string]>,
  modulePath?: string,
): FolderGoModState => ({
  kind: 'parsed',
  folderUri: `file:///ws/${name}`,
  folderName: name,
  goModPath: `/ws/${name}/go.mod`,
  ...(modulePath === undefined ? {} : { modulePath }),
  dependencies: deps.map(([path, version]) => ({ path, version })),
});

describe('buildInstalledTree', () => {
  it('shows the no-folder message when there are zero folders', () => {
    const tree = buildInstalledTree({ folders: [] });
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: 'message', text: messages.NO_FOLDER });
  });

  it('shows the no-go.mod message when all folders are absent', () => {
    const tree = buildInstalledTree({ folders: [absent('a'), absent('b')] });
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: 'message', text: messages.NO_GO_MOD });
  });

  it('ignores absent folders when mixed with a single present folder (flat list)', () => {
    const tree = buildInstalledTree({
      folders: [absent('a'), parsed('b', [['z.com/z', 'v1.0.0'], ['a.com/a', 'v2.0.0']]), absent('c')],
    });
    expect(tree.map((n) => n.kind)).toEqual(['package', 'package']);
    expect(tree).toMatchObject([
      { path: 'a.com/a', version: 'v2.0.0' },
      { path: 'z.com/z', version: 'v1.0.0' },
    ]);
  });

  it('shows a flat sorted list for a single present file', () => {
    const tree = buildInstalledTree({
      folders: [parsed('app', [['b.com/b', 'v1.0.0'], ['a.com/a', 'v1.1.0']])],
    });
    expect(tree.every((n) => n.kind === 'package')).toBe(true);
    expect(tree.map((n) => (n.kind === 'package' ? n.path : ''))).toEqual(['a.com/a', 'b.com/b']);
  });

  it('shows the no-packages message for a present file with no dependencies', () => {
    const tree = buildInstalledTree({ folders: [parsed('app', [])] });
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ kind: 'message', text: messages.NO_PACKAGES });
  });

  it('groups two present files, sorted by label, with module path preferred over folder name', () => {
    const tree = buildInstalledTree({
      folders: [
        parsed('zeta', [['b.com/b', 'v1.0.0'], ['a.com/a', 'v1.0.0']]),
        absent('skipped'),
        parsed('alpha', [['c.com/c', 'v1.0.0']], 'example.com/mod'),
      ],
    });
    expect(tree).toHaveLength(2);
    expect(tree.map((n) => (n.kind === 'group' ? n.label : ''))).toEqual(['example.com/mod', 'zeta']);
    const zeta = tree[1]!;
    expect(zeta).toMatchObject({ kind: 'group', goModPath: '/ws/zeta/go.mod' });
    if (zeta.kind !== 'group') throw new Error('expected group');
    expect(zeta.children.map((c) => (c.kind === 'package' ? c.path : ''))).toEqual(['a.com/a', 'b.com/b']);
  });

  it('renders parse and read errors as error nodes', () => {
    const tree = buildInstalledTree({
      folders: [
        {
          kind: 'parseError',
          folderUri: 'file:///ws/p',
          folderName: 'p',
          goModPath: '/ws/p/go.mod',
          error: { line: 3, message: 'bad token' },
        },
        {
          kind: 'readError',
          folderUri: 'file:///ws/r',
          folderName: 'r',
          goModPath: '/ws/r/go.mod',
          reason: 'EACCES',
        },
      ],
    });
    expect(tree).toHaveLength(2);
    const [p, r] = tree as Array<Extract<(typeof tree)[number], { kind: 'group' }>>;
    expect(p!.children).toEqual([
      expect.objectContaining({
        kind: 'error',
        text: messages.parseError('/ws/p/go.mod', 3, 'bad token'),
      }),
    ]);
    expect(r!.children).toEqual([
      expect.objectContaining({ kind: 'error', text: messages.readError('/ws/r/go.mod', 'EACCES') }),
    ]);
  });

  it('renders a single error file flat', () => {
    const tree = buildInstalledTree({
      folders: [
        absent('a'),
        {
          kind: 'readError',
          folderUri: 'file:///ws/r',
          folderName: 'r',
          goModPath: '/ws/r/go.mod',
          reason: 'boom',
        },
      ],
    });
    expect(tree).toEqual([
      expect.objectContaining({ kind: 'error', text: messages.readError('/ws/r/go.mod', 'boom') }),
    ]);
  });

  it('builds a 500-dependency file well under 2 seconds', () => {
    const lines = ['module example.com/big', '', 'go 1.21', '', 'require ('];
    for (let i = 0; i < 500; i++) {
      lines.push(`\texample.com/dep${String((i * 7919) % 500).padStart(4, '0')} v1.${i}.0`);
    }
    lines.push(')', '');
    const text = lines.join('\n');

    const start = performance.now();
    const result = parseGoMod(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const tree = buildInstalledTree({
      folders: [
        {
          kind: 'parsed',
          folderUri: 'file:///ws/big',
          folderName: 'big',
          goModPath: '/ws/big/go.mod',
          modulePath: result.modulePath,
          dependencies: result.dependencies,
        },
      ],
    });
    const elapsed = performance.now() - start;

    expect(tree).toHaveLength(500);
    const paths = tree.map((n) => (n.kind === 'package' ? n.path : ''));
    expect(paths).toEqual([...paths].sort());
    expect(elapsed).toBeLessThan(2000);
  });
});
