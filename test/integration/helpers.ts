import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { GogetManagerApi, TreeNodeSnapshot } from '../../src/vscode/testApi';

export const EXTENSION_ID = 'goget-manager.goget-manager';

/** Update budget from Requirements 5.1 and 6.1 to 6.7. */
export const UPDATE_BUDGET_MS = 2000;

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Activates the extension and returns its inspection API. */
export async function getApi(): Promise<GogetManagerApi> {
  const extension = vscode.extensions.getExtension<GogetManagerApi>(EXTENSION_ID);
  assert.ok(extension, `extension ${EXTENSION_ID} is not installed in the test host`);
  return extension.isActive ? extension.exports : await extension.activate();
}

/** `[label, description]` for each row, ignoring nesting. */
export function rows(nodes: readonly TreeNodeSnapshot[]): [string, string | undefined][] {
  return nodes.map((n) => [n.label, n.description]);
}

/** Compact, readable form of a tree for assertion failure messages. */
export function describeTree(nodes: readonly TreeNodeSnapshot[], indent = ''): string {
  return nodes
    .map((n) => {
      const line = `${indent}${n.label}${n.description !== undefined ? ` ${n.description}` : ''} [${n.collapsibleState}]`;
      return n.children.length > 0 ? `${line}\n${describeTree(n.children, indent + '  ')}` : line;
    })
    .join('\n');
}

/**
 * Polls `check` until it returns without throwing, or fails with the last error once
 * `timeoutMs` has passed. Returns the elapsed milliseconds.
 */
export async function waitUntil(check: () => void, timeoutMs: number, intervalMs = 25): Promise<number> {
  const start = Date.now();
  for (;;) {
    try {
      check();
      return Date.now() - start;
    } catch (err) {
      if (Date.now() - start >= timeoutMs) {
        throw err;
      }
    }
    await sleep(intervalMs);
  }
}

/** Asserts that the Installed tree's top-level rows equal `expected` within the update budget. */
export async function expectTopLevelRows(
  api: GogetManagerApi,
  expected: readonly [string, string | undefined][],
  timeoutMs = UPDATE_BUDGET_MS,
): Promise<number> {
  return waitUntil(() => {
    const tree = api.getInstalledTree();
    assert.deepStrictEqual(rows(tree), expected, `unexpected tree:\n${describeTree(tree)}`);
  }, timeoutMs);
}

/** Asserts that the tree is exactly one message row with `text` within the update budget. */
export async function expectSingleMessage(api: GogetManagerApi, text: string): Promise<number> {
  return waitUntil(() => {
    const tree = api.getInstalledTree();
    assert.deepStrictEqual(rows(tree), [[text, undefined]], `unexpected tree:\n${describeTree(tree)}`);
    assert.strictEqual(tree[0]?.children.length, 0);
  }, UPDATE_BUDGET_MS);
}

/** The first workspace folder's path. */
export function firstFolderPath(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'the test host has no workspace folder open');
  return folder.uri.fsPath;
}

export const goModPathIn = (folderPath: string): string => path.join(folderPath, 'go.mod');

/** Writes a go.mod with a plain `require` block for `deps`. */
export function renderGoMod(moduleName: string, deps: readonly (readonly [string, string])[]): string {
  const body = deps.map(([p, v]) => `\t${p} ${v}`).join('\n');
  return `module ${moduleName}\n\ngo 1.21\n\nrequire (\n${body}\n)\n`;
}

export function writeFile(filePath: string, content: string): void {
  fs.writeFileSync(filePath, content, 'utf8');
}

export function removeFile(filePath: string): void {
  fs.rmSync(filePath, { force: true });
}

/**
 * VS Code starts its file watchers asynchronously, and changes made before a watcher is
 * ready are never reported. Rewrites `goModPath` with a probe go.mod until the tree shows
 * it (which proves the watcher is delivering events), so the tests that follow measure
 * update latency rather than watcher start-up. The caller restores its own state afterwards.
 */
export async function waitForWatcherReady(api: GogetManagerApi, goModPath: string): Promise<void> {
  // Let the initial load finish first; otherwise it could read the probe itself and look like a watcher event.
  await refresh();
  const deadline = Date.now() + 20000;
  for (let attempt = 1; ; attempt++) {
    writeFile(
      goModPath,
      renderGoMod('example.com/probe', [['example.com/watcher-probe', 'v0.0.0']]) + `// attempt ${attempt}\n`,
    );
    try {
      // Matches both the flat layout and a multi-root group layout.
      await waitUntil(() => {
        const tree = api.getInstalledTree();
        const labels = [...tree, ...tree.flatMap((n) => n.children)].map((n) => n.label);
        assert.ok(labels.includes('example.com/watcher-probe'), `probe not visible:\n${describeTree(tree)}`);
      }, 1500);
      return;
    } catch (err) {
      if (Date.now() >= deadline) {
        throw err;
      }
    }
  }
}

export async function refresh(): Promise<void> {
  await vscode.commands.executeCommand('gogetManager.refresh');
}
