import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetailController } from '../../src/core/detailController';
import type { HostToDetail } from '../../src/core/detailProtocol';
import { collectInstalledModulePaths, isInstalledPackage } from '../../src/core/installedMatch';
import { PackageActions, type GoRunResult } from '../../src/core/packageActions';
import {
  GoModRepository,
  type DisposableLike,
  type FileReader,
  type GoModWatcher,
  type UriLike,
  type WorkspaceFolderLike,
  type WorkspaceFoldersSource,
} from '../../src/vscode/goModRepository';
import { InstalledTreeProvider } from '../../src/vscode/installedTreeProvider';
import { SearchViewProvider } from '../../src/vscode/searchViewProvider';
import { FakeSearchClient, RecordingOutput, createControllerHarness, flushPromises } from './searchArbitraries';
import { FakeTimers } from './fakeTimers';
import { EventEmitter, Uri, type Disposable } from './vscodeStub';

const SFTP = readFileSync(join(__dirname, '..', 'fixtures', 'package-detail', 'sftp-sample.html'), 'utf8');
const SFTP_PATH = 'github.com/pkg/sftp/v2';
const GO_MOD_PATH = '/ws/app/go.mod';

const folder: WorkspaceFolderLike = { uri: Uri.file('/ws/app'), name: 'app' };

/** go.mod text kept in memory; the fake Go command edits it the way `go get` / `go mod edit` would. */
class FakeGoMod {
  requires: string[] = [];

  text(): string {
    return ['module example.com/app', '', 'go 1.21', '', ...this.requires.map((p) => `require ${p} v1.0.0`)].join('\n');
  }

  run(args: readonly string[]): GoRunResult {
    if (args[0] === 'get') {
      this.requires.push(args[2]!);
    } else {
      const module = args[2]!.replace('-droprequire=', '');
      this.requires = this.requires.filter((p) => p !== module);
    }
    return { ok: true, output: '' };
  }
}

function setup() {
  const goMod = new FakeGoMod();
  const fs: FileReader = {
    goModUri: (f) => Uri.file(`${f.uri.fsPath}/go.mod`),
    readFile: (uri: UriLike) => {
      expect(uri.fsPath).toBe(GO_MOD_PATH);
      return Promise.resolve(new TextEncoder().encode(goMod.text()));
    },
  };
  const watcher: GoModWatcher = {
    dispose: () => undefined,
    onDidCreate: () => ({ dispose: () => undefined }),
    onDidChange: () => ({ dispose: () => undefined }),
    onDidDelete: () => ({ dispose: () => undefined }),
  };
  const workspace: WorkspaceFoldersSource = {
    getFolders: () => [folder],
    onDidChangeWorkspaceFolders: (): DisposableLike => ({ dispose: () => undefined }),
  };
  const repository = new GoModRepository({
    fs,
    output: new RecordingOutput(),
    watchers: () => watcher,
    workspace,
  });

  const tree = new InstalledTreeProvider(repository);
  const treePaths = (): string[] =>
    tree.getChildren().flatMap((node) => (node.kind === 'package' ? [node.path] : []));

  const searchHarness = createControllerHarness();
  const searchProvider = new SearchViewProvider(Uri.file('/ext') as never, searchHarness.controller, {
    onDidChange: repository.onDidChange,
    modules: () => collectInstalledModulePaths(repository.snapshot()),
  });
  const resolveSearchView = () => {
    const received = new EventEmitter<unknown>();
    const posted: any[] = [];
    const view = {
      visible: true,
      webview: {
        cspSource: 'x:',
        options: undefined as unknown,
        html: '',
        asWebviewUri: (uri: Uri): Uri => uri,
        postMessage: (message: unknown): Promise<boolean> => {
          posted.push(message);
          return Promise.resolve(true);
        },
        onDidReceiveMessage: (listener: (e: unknown) => unknown): Disposable => received.event(listener),
      },
      onDidDispose: (): Disposable => ({ dispose: () => undefined }),
    };
    searchProvider.resolveWebviewView(view as never);
    received.fire({ type: 'ready' });
    return posted;
  };
  const installedMessages = (posted: any[]): string[][] =>
    posted.filter((m) => m.type === 'installed').map((m) => m.modules);

  const runs: Array<{ cwd: string; args: readonly string[] }> = [];
  let nextResult: GoRunResult | undefined;
  const actions = new PackageActions({
    snapshot: () => repository.snapshot(),
    run: (cwd, args) => {
      runs.push({ cwd, args });
      if (nextResult !== undefined) {
        return Promise.resolve(nextResult);
      }
      return Promise.resolve(goMod.run(args));
    },
    refresh: () => repository.refreshAll(),
    pickFolder: () => Promise.resolve(undefined),
    dirname: (p) => p.replace(/\/[^/]*$/, ''),
    output: new RecordingOutput(),
  });

  const client = new FakeSearchClient();
  const detail = new DetailController({
    client,
    output: new RecordingOutput(),
    timers: new FakeTimers(),
    isInstalled: (path) => isInstalledPackage(path, new Set(collectInstalledModulePaths(repository.snapshot()))),
    actions,
  });
  const messages: HostToDetail[] = [];
  detail.onDidChange((m) => messages.push(m));
  repository.onDidChange(() => detail.refreshInstalled());

  const open = async (path: string): Promise<void> => {
    detail.show(path);
    client.calls[client.calls.length - 1]!.settle({ kind: 'ok', html: SFTP });
    await flushPromises();
  };
  return {
    goMod,
    repository,
    treePaths,
    resolveSearchView,
    installedMessages,
    runs,
    detail,
    messages,
    open,
    failNext: (result: GoRunResult) => {
      nextResult = result;
    },
  };
}

describe('install/uninstall keeps the three views in sync', () => {
  it('install then uninstall follows go.mod in the Installed view, Search view and Detail tab', async () => {
    const s = setup();
    await s.repository.initialize();
    const search = s.resolveSearchView();
    await s.open(SFTP_PATH);

    expect(s.treePaths()).not.toContain(SFTP_PATH);
    expect(s.installedMessages(search).at(-1)).not.toContain(SFTP_PATH);
    expect(s.detail.state.installed).toBe(false);

    s.detail.requestInstall();
    expect(s.messages.at(-1)).toEqual({ type: 'action', installed: false, busy: 'install' });
    await flushPromises();

    expect(s.runs.at(-1)).toEqual({ cwd: '/ws/app', args: ['get', '--', SFTP_PATH] });
    expect(s.treePaths()).toContain(SFTP_PATH);
    expect(s.installedMessages(search).at(-1)).toContain(SFTP_PATH);
    expect(s.messages.at(-1)).toEqual({ type: 'action', installed: true });
    expect(s.detail.state).toMatchObject({ installed: true });

    s.detail.requestUninstall();
    await flushPromises();

    expect(s.runs.at(-1)).toEqual({ cwd: '/ws/app', args: ['mod', 'edit', `-droprequire=${SFTP_PATH}`] });
    expect(s.treePaths()).not.toContain(SFTP_PATH);
    expect(s.installedMessages(search).at(-1)).not.toContain(SFTP_PATH);
    expect(s.messages.at(-1)).toEqual({ type: 'action', installed: false });
  });

  it('a failed install changes nothing and reports the error', async () => {
    const s = setup();
    await s.repository.initialize();
    const search = s.resolveSearchView();
    await s.open(SFTP_PATH);
    const before = s.installedMessages(search).at(-1);

    s.failNext({ ok: false, reason: 'failed', output: 'boom' });
    s.detail.requestInstall();
    await flushPromises();

    expect(s.goMod.requires).toEqual([]);
    expect(s.treePaths()).not.toContain(SFTP_PATH);
    expect(s.installedMessages(search).at(-1)).toEqual(before);
    expect(s.detail.state.installed).toBe(false);
    expect(s.detail.state.busy).toBeUndefined();
    expect(s.detail.state.actionError).toContain('boom');
  });

  it('a Search view resolved after the install shows the module on first paint', async () => {
    const s = setup();
    await s.repository.initialize();
    await s.open(SFTP_PATH);
    s.detail.requestInstall();
    await flushPromises();

    const search = s.resolveSearchView();
    expect(search[0]).toEqual({ type: 'installed', modules: [SFTP_PATH] });
  });

  it('a sub-package of an installed module shows Uninstall and drops the module', async () => {
    const s = setup();
    s.goMod.requires = [SFTP_PATH];
    await s.repository.initialize();
    await s.open(`${SFTP_PATH}/internal/x`);
    expect(s.detail.state.installed).toBe(true);

    s.detail.requestUninstall();
    await flushPromises();
    expect(s.runs.at(-1)!.args).toEqual(['mod', 'edit', `-droprequire=${SFTP_PATH}`]);
    expect(s.treePaths()).not.toContain(SFTP_PATH);
  });
});
