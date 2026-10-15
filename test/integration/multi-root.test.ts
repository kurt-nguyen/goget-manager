import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GogetManagerApi, TreeNodeSnapshot } from '../../src/vscode/testApi';
import { describeTree, getApi, refresh, removeFile, rows, waitForWatcherReady, waitUntil, writeFile } from './helpers';

type Row = [string, string | undefined];

const ZULU_ROWS: Row[] = [
  ['github.com/BurntSushi/toml', 'v1.3.2'],
  ['github.com/spf13/cobra', 'v1.8.0'],
];
const ALPHA_ROWS: Row[] = [
  ['github.com/google/uuid', 'v1.6.0'],
  ['golang.org/x/text', 'v0.14.0'],
];
const MID_ROWS: Row[] = [['github.com/stretchr/testify', 'v1.9.0']];

/** The workspace file lists zulu-app before alpha-app, so sorted output proves sorting, not file order. */
describe('multi-root workspace', () => {
  let api: GogetManagerApi;
  let rootDir: string;
  let zuluGoMod: string;
  let originals: Map<string, string>;

  const folderUri = (name: string): vscode.Uri => vscode.Uri.file(path.join(rootDir, name));
  const currentFolderNames = (): string[] =>
    (vscode.workspace.workspaceFolders ?? []).map((f) => path.basename(f.uri.fsPath));

  const groups = (): TreeNodeSnapshot[] => api.getInstalledTree().slice();

  const expectGroups = (expected: readonly (readonly [string, Row[]])[], timeoutMs = 2000): Promise<number> =>
    waitUntil(() => {
      const tree = api.getInstalledTree();
      const message = `unexpected tree:\n${describeTree(tree)}`;
      assert.deepStrictEqual(
        tree.map((g) => g.label),
        expected.map(([label]) => label),
        message,
      );
      tree.forEach((group, i) => {
        assert.strictEqual(group.collapsibleState, 'expanded', `${group.label} should be expanded`);
        assert.deepStrictEqual(rows(group.children), expected[i]?.[1], message);
      });
    }, timeoutMs);

  /** Calls `updateWorkspaceFolders` and resolves once VS Code reports the change. */
  async function changeFolders(start: number, deleteCount: number, add?: vscode.Uri): Promise<void> {
    const changed = new Promise<void>((resolve) => {
      const subscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        subscription.dispose();
        resolve();
      });
    });
    const accepted = add
      ? vscode.workspace.updateWorkspaceFolders(start, deleteCount, { uri: add })
      : vscode.workspace.updateWorkspaceFolders(start, deleteCount);
    assert.ok(accepted, 'VS Code rejected the workspace folder update');
    await changed;
  }

  async function addFolder(name: string): Promise<void> {
    await changeFolders(vscode.workspace.workspaceFolders?.length ?? 0, 0, folderUri(name));
  }

  async function removeFolder(name: string): Promise<void> {
    const index = currentFolderNames().indexOf(name);
    assert.ok(index >= 0, `${name} is not an open workspace folder`);
    await changeFolders(index, 1);
  }

  before(async () => {
    api = await getApi();
    const first = vscode.workspace.workspaceFolders?.[0];
    assert.ok(first, 'the test host has no workspace folder open');
    rootDir = path.dirname(first.uri.fsPath);
    zuluGoMod = path.join(rootDir, 'zulu-app', 'go.mod');
    originals = new Map(
      ['zulu-app', 'alpha-app', 'mid-app'].map((name) => {
        const file = path.join(rootDir, name, 'go.mod');
        return [file, fs.readFileSync(file, 'utf8')];
      }),
    );
    await waitForWatcherReady(api, zuluGoMod);
    writeFile(zuluGoMod, originals.get(zuluGoMod) ?? '');
    await refresh();
  });

  afterEach(async () => {
    // Put folders and files back so tests stay independent of each other.
    for (const [file, content] of originals) {
      writeFile(file, content);
    }
    for (const name of ['mid-app']) {
      if (currentFolderNames().includes(name)) {
        await removeFolder(name);
      }
    }
    if (!currentFolderNames().includes('alpha-app')) {
      await addFolder('alpha-app');
    }
    await refresh();
  });

  // Requirements 5.4 and 5.5
  it('shows one expanded group per go.mod, labeled by module path and sorted by label', async () => {
    assert.deepStrictEqual(currentFolderNames(), ['zulu-app', 'alpha-app']);
    await expectGroups([
      ['example.com/alpha', ALPHA_ROWS],
      ['example.com/zulu', ZULU_ROWS],
    ]);
  });

  // Requirements 5.2 and 5.3 inside a group
  it('shows the path as the label and the version as the description inside each group', () => {
    const [alpha] = groups();
    assert.ok(alpha);
    assert.deepStrictEqual(rows(alpha.children), ALPHA_ROWS);
    for (const row of alpha.children) {
      assert.strictEqual(row.tooltip, `${row.label} ${row.description}`);
    }
  });

  // Requirement 6.2 (added folder)
  it('adds a group within 2 seconds when a workspace folder is added', async () => {
    await addFolder('mid-app');
    await expectGroups([
      ['example.com/alpha', ALPHA_ROWS],
      ['example.com/mid', MID_ROWS],
      ['example.com/zulu', ZULU_ROWS],
    ]);
  });

  // Requirement 6.2 (removed folder)
  it('drops every row of a workspace folder within 2 seconds of its removal', async () => {
    await addFolder('mid-app');
    await expectGroups([
      ['example.com/alpha', ALPHA_ROWS],
      ['example.com/mid', MID_ROWS],
      ['example.com/zulu', ZULU_ROWS],
    ]);

    await removeFolder('mid-app');
    await expectGroups([
      ['example.com/alpha', ALPHA_ROWS],
      ['example.com/zulu', ZULU_ROWS],
    ]);
  });

  // Requirements 6.2 and 5.7: with one go.mod left the list is flat again
  it('falls back to a flat list when only one go.mod remains open', async () => {
    await removeFolder('alpha-app');
    await waitUntil(() => {
      const tree = api.getInstalledTree();
      assert.deepStrictEqual(rows(tree), ZULU_ROWS, describeTree(tree));
      assert.ok(tree.every((n) => n.children.length === 0));
    }, 2000);
  });

  // Requirement 6.5: other folders stay unchanged
  it('removes only the deleted go.mod folder rows and leaves other folders unchanged', async () => {
    removeFile(zuluGoMod);
    await waitUntil(() => {
      const tree = api.getInstalledTree();
      // Only alpha-app still has a go.mod, so it is shown flat with the same rows it had in its group.
      assert.deepStrictEqual(rows(tree), ALPHA_ROWS, describeTree(tree));
    }, 2000);
  });

  // Requirement 6.1 / 6.4 across folders
  it('re-reads every folder from disk when Refresh runs', async () => {
    writeFile(zuluGoMod, 'module example.com/zulu\n\nrequire example.com/new v0.0.1\n');
    await refresh();
    await expectGroups(
      [
        ['example.com/alpha', ALPHA_ROWS],
        ['example.com/zulu', [['example.com/new', 'v0.0.1']]],
      ],
      0,
    );
  });
});
