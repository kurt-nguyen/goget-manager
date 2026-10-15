import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from '@vscode/test-cli';

const root = fileURLToPath(new URL('.', import.meta.url));
const fixturesRoot = resolve(root, 'test', 'fixtures');

// Tests mutate go.mod files, so every run opens a throwaway copy of the fixture
// and the checked-in fixtures stay untouched.
const scratchRoot = join(tmpdir(), 'goget-manager-integration');
rmSync(scratchRoot, { recursive: true, force: true });
mkdirSync(scratchRoot, { recursive: true });

/** Copies a fixture directory into the scratch area and returns the copy's path. */
function scratchCopy(name) {
  const target = join(scratchRoot, name);
  cpSync(join(fixturesRoot, name), target, { recursive: true });
  return target;
}

const launchArgs = ['--disable-extensions', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes'];

/** One VS Code launch per workspace shape; each runs one compiled test file. */
const configFor = (label, workspaceFolder) => ({
  label,
  files: `out/test/integration/${label}.test.js`,
  workspaceFolder,
  launchArgs,
  mocha: { ui: 'bdd', timeout: 30000, color: true },
});

export default defineConfig([
  configFor('single-folder', scratchCopy('single-folder')),
  configFor('multi-root', join(scratchCopy('multi-root'), 'multi.code-workspace')),
  configFor('no-go-mod', scratchCopy('no-go-mod')),
]);
