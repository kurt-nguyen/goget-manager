import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import type { FolderGoModState, InstalledSnapshot } from '../../src/core/installedModel';
import * as messages from '../../src/core/messages';
import { InstalledTreeProvider, type InstalledRepository } from '../../src/vscode/installedTreeProvider';

const parsed = (name: string, deps: Array<[string, string]>): FolderGoModState => ({
  kind: 'parsed',
  folderUri: `file:///ws/${name}`,
  folderName: name,
  goModPath: `/ws/${name}/go.mod`,
  dependencies: deps.map(([path, version]) => ({ path, version })),
});

class FakeRepo implements InstalledRepository {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  readonly snapshot = vi.fn<() => InstalledSnapshot>();

  constructor(initial: InstalledSnapshot) {
    this.snapshot.mockReturnValue(initial);
  }

  change(next?: InstalledSnapshot): void {
    if (next) {
      this.snapshot.mockReturnValue(next);
    }
    this.emitter.fire();
  }
}

const single: InstalledSnapshot = {
  folders: [parsed('a', [['z.com/z', 'v1.0.0'], ['a.com/a', 'v2.0.0']])],
};
const multi: InstalledSnapshot = {
  folders: [parsed('b', [['b.com/b', 'v1.1.0']]), parsed('a', [['a.com/a', 'v2.0.0']])],
};

describe('InstalledTreeProvider.getChildren', () => {
  it('returns the sorted package nodes at the root for a single go.mod', () => {
    const provider = new InstalledTreeProvider(new FakeRepo(single));
    expect(provider.getChildren()).toMatchObject([
      { kind: 'package', path: 'a.com/a', version: 'v2.0.0' },
      { kind: 'package', path: 'z.com/z', version: 'v1.0.0' },
    ]);
  });

  it('returns the empty-state message at the root when there are no folders', () => {
    const provider = new InstalledTreeProvider(new FakeRepo({ folders: [] }));
    expect(provider.getChildren()).toMatchObject([{ kind: 'message', text: messages.NO_FOLDER }]);
  });

  it('returns groups at the root and their packages as group children', () => {
    const provider = new InstalledTreeProvider(new FakeRepo(multi));
    const roots = provider.getChildren();
    expect(roots.map((n) => n.kind)).toEqual(['group', 'group']);
    expect(roots.map((n) => (n.kind === 'group' ? n.label : ''))).toEqual(['a', 'b']);
    expect(provider.getChildren(roots[0])).toMatchObject([{ kind: 'package', path: 'a.com/a' }]);
  });

  it('returns no children for non-group elements', () => {
    const provider = new InstalledTreeProvider(new FakeRepo(single));
    const [pkg] = provider.getChildren();
    expect(provider.getChildren(pkg)).toEqual([]);
  });

  it('caches the model between calls', () => {
    const repo = new FakeRepo(single);
    const provider = new InstalledTreeProvider(repo);
    provider.getChildren();
    provider.getChildren();
    expect(repo.snapshot).toHaveBeenCalledTimes(1);
  });
});

describe('InstalledTreeProvider refresh on repository change', () => {
  it('fires onDidChangeTreeData and rebuilds from a fresh snapshot', () => {
    const repo = new FakeRepo(single);
    const provider = new InstalledTreeProvider(repo);
    const fired = vi.fn();
    provider.onDidChangeTreeData(fired);

    expect(provider.getChildren()).toHaveLength(2);
    repo.change({ folders: [parsed('a', [['only.com/x', 'v0.1.0']])] });

    expect(fired).toHaveBeenCalledTimes(1);
    expect(provider.getChildren()).toMatchObject([{ kind: 'package', path: 'only.com/x' }]);
    expect(repo.snapshot).toHaveBeenCalledTimes(2);
  });

  it('stops reacting after dispose', () => {
    const repo = new FakeRepo(single);
    const provider = new InstalledTreeProvider(repo);
    const fired = vi.fn();
    provider.onDidChangeTreeData(fired);
    provider.dispose();
    repo.change();
    expect(fired).not.toHaveBeenCalled();
  });
});

describe('InstalledTreeProvider fallback error node', () => {
  it('returns a single error node when snapshot() throws an Error', () => {
    const repo = new FakeRepo(single);
    repo.snapshot.mockImplementation(() => {
      throw new Error('boom');
    });
    const provider = new InstalledTreeProvider(repo);
    const children = provider.getChildren();
    expect(children).toHaveLength(1);
    expect(children[0]).toMatchObject({ kind: 'error', id: 'msg:root:internal-error' });
    expect((children[0] as { text: string }).text).toContain('boom');
  });

  it('stringifies non-Error throwables', () => {
    const repo = new FakeRepo(single);
    repo.snapshot.mockImplementation(() => {
      throw 'plain failure';
    });
    const provider = new InstalledTreeProvider(repo);
    expect((provider.getChildren()[0] as { text: string }).text).toContain('plain failure');
  });

  it('does not cache the failure: recovers once snapshot() works again', () => {
    const repo = new FakeRepo(single);
    repo.snapshot.mockImplementationOnce(() => {
      throw new Error('boom');
    });
    const provider = new InstalledTreeProvider(repo);
    expect(provider.getChildren()[0]).toMatchObject({ kind: 'error' });
    expect(provider.getChildren()).toMatchObject([{ kind: 'package' }, { kind: 'package' }]);
  });

  it('renders the error node as a TreeItem with the error icon', () => {
    const repo = new FakeRepo(single);
    repo.snapshot.mockImplementation(() => {
      throw new Error('boom');
    });
    const provider = new InstalledTreeProvider(repo);
    const item = provider.getTreeItem(provider.getChildren()[0]!);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('error');
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });
});

describe('InstalledTreeProvider.getTreeItem', () => {
  it('maps a package node', () => {
    const provider = new InstalledTreeProvider(new FakeRepo(single));
    const pkg = provider.getChildren()[0]!;
    const item = provider.getTreeItem(pkg);
    expect(item.label).toBe('a.com/a');
    expect(item.description).toBe('v2.0.0');
    expect(item.tooltip).toBe('a.com/a v2.0.0');
    expect(item.id).toBe(pkg.id);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('package');
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });

  it('maps a group node as expanded with a folder icon and go.mod tooltip', () => {
    const provider = new InstalledTreeProvider(new FakeRepo(multi));
    const group = provider.getChildren()[0]!;
    const item = provider.getTreeItem(group);
    expect(item.label).toBe('a');
    expect(item.tooltip).toBe('/ws/a/go.mod');
    expect(item.description).toBeUndefined();
    expect(item.id).toBe(group.id);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('folder');
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.Expanded);
  });

  it('maps a message node with an info icon and no description or tooltip', () => {
    const provider = new InstalledTreeProvider(new FakeRepo({ folders: [] }));
    const msg = provider.getChildren()[0]!;
    const item = provider.getTreeItem(msg);
    expect(item.label).toBe(messages.NO_FOLDER);
    expect(item.id).toBe(msg.id);
    expect(item.description).toBeUndefined();
    expect(item.tooltip).toBeUndefined();
    expect((item.iconPath as vscode.ThemeIcon).id).toBe('info');
    expect(item.collapsibleState).toBe(vscode.TreeItemCollapsibleState.None);
  });
});
