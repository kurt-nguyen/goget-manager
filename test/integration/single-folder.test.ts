import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { NO_GO_MOD } from '../../src/core/messages';
import type { GogetManagerApi } from '../../src/vscode/testApi';
import {
  UPDATE_BUDGET_MS,
  describeTree,
  expectSingleMessage,
  expectTopLevelRows,
  firstFolderPath,
  getApi,
  goModPathIn,
  refresh,
  removeFile,
  renderGoMod,
  rows,
  sleep,
  waitForWatcherReady,
  waitUntil,
  writeFile,
} from './helpers';

/** The checked-in fixture's dependencies, sorted by code point on the package path. */
const FIXTURE_ROWS: [string, string | undefined][] = [
  ['github.com/BurntSushi/toml', 'v1.3.2'],
  ['github.com/google/uuid', 'v1.6.0+incompatible'],
  ['github.com/spf13/cobra', 'v1.8.0'],
  ['github.com/stretchr/testify', 'v1.9.0'],
  ['golang.org/x/text', 'v0.14.0'],
];

describe('single workspace folder', () => {
  let api: GogetManagerApi;
  let goModPath: string;
  let originalContent: string;

  before(async () => {
    api = await getApi();
    goModPath = goModPathIn(firstFolderPath());
    originalContent = fs.readFileSync(goModPath, 'utf8');
    await waitForWatcherReady(api, goModPath);
  });

  beforeEach(async () => {
    // Put the scratch copy back to the fixture state and sync the tree through the refresh command.
    writeFile(goModPath, originalContent);
    await refresh();
    await expectTopLevelRows(api, FIXTURE_ROWS);
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  describe('view container', () => {
    // Requirements 1.5 and 1.8
    it('opens the Goget Manager container and resolves both the Search and Installed views within 1 second', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.goget-manager');
      const elapsed = await waitUntil(() => {
        assert.ok(api.isInstalledViewVisible(), 'Installed view is not visible');
        assert.ok(api.isSearchViewResolved(), 'Search view was not resolved');
      }, 1000);
      assert.ok(elapsed <= 1000);
    });
  });

  describe('Installed list', () => {
    // Requirements 5.1, 5.2, 5.3, 5.4, 5.7
    it('shows a flat list sorted by code point, with one row per dependency', () => {
      const tree = api.getInstalledTree();
      assert.deepStrictEqual(rows(tree), FIXTURE_ROWS, describeTree(tree));
      for (const node of tree) {
        assert.strictEqual(node.children.length, 0, `${node.label} should be a leaf: no group node for one go.mod`);
        assert.strictEqual(node.collapsibleState, 'none');
      }
    });

    // Requirement 5.6 (tooltip text), shown alongside the label and description of 5.2 and 5.3
    it('gives each row a tooltip with the package path and version', () => {
      for (const node of api.getInstalledTree()) {
        assert.strictEqual(node.tooltip, `${node.label} ${node.description}`);
      }
    });
  });

  describe('keeping the list current', () => {
    // Requirement 6.1
    it('updates within 2 seconds when go.mod is rewritten on disk', async () => {
      writeFile(
        goModPath,
        renderGoMod('example.com/single', [
          ['example.com/zeta', 'v0.1.0'],
          ['example.com/alpha', 'v2.0.0'],
        ]),
      );
      await expectTopLevelRows(api, [
        ['example.com/alpha', 'v2.0.0'],
        ['example.com/zeta', 'v0.1.0'],
      ]);
    });

    // Requirement 6.7
    it('ends with exactly one row per dependency after several rapid rewrites', async () => {
      for (let i = 1; i <= 5; i++) {
        const deps = Array.from({ length: i }, (_, k): [string, string] => [`example.com/pkg${k}`, `v1.${i}.0`]);
        writeFile(goModPath, renderGoMod('example.com/single', deps));
        await sleep(40);
      }
      const finalRows: [string, string | undefined][] = Array.from({ length: 5 }, (_, k) => [
        `example.com/pkg${k}`,
        'v1.5.0',
      ]);
      await expectTopLevelRows(api, finalRows);

      // Nothing late arrives and duplicates or reverts the result.
      await sleep(800);
      const tree = api.getInstalledTree();
      assert.deepStrictEqual(rows(tree), finalRows, describeTree(tree));
    });

    // Requirements 6.5 and 7.8
    it('removes every row within 2 seconds when go.mod is deleted, and restores them when it comes back', async () => {
      removeFile(goModPath);
      await expectSingleMessage(api, NO_GO_MOD);

      writeFile(goModPath, originalContent);
      await expectTopLevelRows(api, FIXTURE_ROWS);
    });

    // Requirement 6.1: unsaved editor changes are ignored
    it('leaves the list unchanged while an editor holds unsaved changes to go.mod', async () => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(goModPath));
      const editor = await vscode.window.showTextDocument(document);
      const applied = await editor.edit((edit) => {
        edit.insert(new vscode.Position(document.lineCount, 0), 'require example.com/unsaved v9.9.9\n');
      });
      assert.ok(applied, 'the editor edit was not applied');
      assert.ok(document.isDirty, 'the document should have unsaved changes');

      // Longer than the 300 ms debounce plus watcher latency: any reaction to the edit would show by now.
      await sleep(1200);
      const tree = api.getInstalledTree();
      assert.deepStrictEqual(rows(tree), FIXTURE_ROWS, describeTree(tree));
      assert.ok(document.isDirty);

      await vscode.commands.executeCommand('workbench.action.files.revert');
      assert.ok(!document.isDirty, 'the unsaved edit should be reverted so it cannot leak into later tests');
    });
  });

  describe('Refresh command', () => {
    // Requirement 6.4
    it('re-reads go.mod from disk before the command completes', async () => {
      writeFile(goModPath, renderGoMod('example.com/single', [['example.com/refreshed', 'v3.2.1']]));
      await refresh();
      // Checked immediately: no polling, so this proves the command itself did the read.
      await expectTopLevelRows(api, [['example.com/refreshed', 'v3.2.1']], 0);
    });

    // Requirement 6.4 within the 2 second budget
    it('picks up an on-disk change within 2 seconds of being selected', async () => {
      writeFile(goModPath, renderGoMod('example.com/single', [['example.com/again', 'v0.0.1']]));
      const start = Date.now();
      await refresh();
      await expectTopLevelRows(api, [['example.com/again', 'v0.0.1']]);
      assert.ok(Date.now() - start <= UPDATE_BUDGET_MS);
    });
  });
});
