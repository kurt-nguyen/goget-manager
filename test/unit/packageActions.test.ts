import { describe, expect, it, vi } from 'vitest';
import type { FolderGoModState, InstalledSnapshot } from '../../src/core/installedModel';
import { GO_NOT_FOUND, NOT_INSTALLABLE, NO_GO_MOD_FOR_INSTALL, goFailed, goTimedOut, notRequired } from '../../src/core/messages';
import {
  PackageActions,
  type ActionCandidate,
  type GoRunResult,
  type PackageActionsDeps,
} from '../../src/core/packageActions';
import { RecordingOutput, flushPromises } from './searchArbitraries';

function parsed(name: string, deps: string[]): FolderGoModState {
  return {
    kind: 'parsed',
    folderUri: `file:///ws/${name}`,
    folderName: name,
    goModPath: `/ws/${name}/go.mod`,
    dependencies: deps.map((path) => ({ path, version: 'v1.0.0' })),
  };
}

function setup(folders: FolderGoModState[], result: GoRunResult = { ok: true, output: '' }) {
  const snapshot: InstalledSnapshot = { folders };
  const run = vi.fn<PackageActionsDeps['run']>(() => Promise.resolve(result));
  const refresh = vi.fn<PackageActionsDeps['refresh']>(() => Promise.resolve());
  const pickFolder = vi.fn<PackageActionsDeps['pickFolder']>((candidates) => Promise.resolve(candidates[candidates.length - 1]));
  const output = new RecordingOutput();
  const actions = new PackageActions({
    snapshot: () => snapshot,
    run,
    refresh,
    pickFolder,
    dirname: (p) => p.replace(/\/[^/]*$/, ''),
    output,
  });
  return { actions, run, refresh, pickFolder, output };
}

describe('PackageActions.install', () => {
  it('runs go get in the folder of the only go.mod, then refreshes', async () => {
    const { actions, run, refresh, pickFolder } = setup([parsed('a', [])]);
    await expect(actions.install('github.com/spf13/cobra')).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith('/ws/a', ['get', '--', 'github.com/spf13/cobra']);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(pickFolder).not.toHaveBeenCalled();
  });

  it('refuses standard library and flag-like paths without running Go', async () => {
    const { actions, run, refresh } = setup([parsed('a', [])]);
    for (const path of ['os', 'net/http', '-evil.com/x']) {
      await expect(actions.install(path)).resolves.toEqual({ ok: false, error: NOT_INSTALLABLE });
    }
    expect(run).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('reports a missing go.mod', async () => {
    const { actions, run } = setup([{ kind: 'absent', folderUri: 'file:///ws/a', folderName: 'a' }]);
    await expect(actions.install('github.com/spf13/cobra')).resolves.toEqual({ ok: false, error: NO_GO_MOD_FOR_INSTALL });
    expect(run).not.toHaveBeenCalled();
  });

  it('asks which folder to use when there are several', async () => {
    const { actions, run, pickFolder } = setup([parsed('a', []), parsed('b', [])]);
    await actions.install('github.com/spf13/cobra');
    expect(pickFolder).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('/ws/b', ['get', '--', 'github.com/spf13/cobra']);
  });

  it('does nothing when the picker is dismissed', async () => {
    const { actions, run, refresh, pickFolder } = setup([parsed('a', []), parsed('b', [])]);
    pickFolder.mockResolvedValue(undefined);
    await expect(actions.install('github.com/spf13/cobra')).resolves.toEqual({ ok: false, cancelled: true });
    expect(run).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'notFound', output: '' }, GO_NOT_FOUND],
    [{ ok: false, reason: 'timeout', output: '' }, goTimedOut('install')],
    [{ ok: false, reason: 'failed', output: 'go: downloading\ngo: no such host\n' }, goFailed('install', 'go: no such host')],
  ] as const)('maps %j to a message and still refreshes', async (result, error) => {
    const { actions, refresh } = setup([parsed('a', [])], result);
    await expect(actions.install('github.com/spf13/cobra')).resolves.toEqual({ ok: false, error });
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('survives a throwing runner, picker and refresh', async () => {
    const a = setup([parsed('a', [])]);
    a.run.mockRejectedValue(new Error('spawn exploded'));
    await expect(a.actions.install('github.com/spf13/cobra')).resolves.toMatchObject({ ok: false });

    const b = setup([parsed('a', []), parsed('b', [])]);
    b.pickFolder.mockRejectedValue(new Error('no ui'));
    await expect(b.actions.install('github.com/spf13/cobra')).resolves.toMatchObject({ ok: false });

    const c = setup([parsed('a', [])]);
    c.refresh.mockRejectedValue(new Error('reload failed'));
    await expect(c.actions.install('github.com/spf13/cobra')).resolves.toEqual({ ok: true });
  });

  it('runs overlapping actions one after the other, even after a failure', async () => {
    const { actions, run } = setup([parsed('a', [])]);
    const resolvers: Array<(r: GoRunResult) => void> = [];
    run.mockImplementation(() => new Promise<GoRunResult>((resolve) => resolvers.push(resolve)));
    const first = actions.install('github.com/a/one');
    const second = actions.install('github.com/a/two');
    await flushPromises();
    expect(run).toHaveBeenCalledTimes(1);
    resolvers[0]!({ ok: false, reason: 'failed', output: 'boom' });
    await expect(first).resolves.toMatchObject({ ok: false });
    await flushPromises();
    expect(run).toHaveBeenCalledTimes(2);
    resolvers[1]!({ ok: true, output: '' });
    await expect(second).resolves.toEqual({ ok: true });
  });
});

describe('PackageActions.uninstall', () => {
  it('drops the parent module of a sub-package', async () => {
    const { actions, run, refresh } = setup([parsed('a', ['github.com/spf13/cobra'])]);
    await expect(actions.uninstall('github.com/spf13/cobra/doc')).resolves.toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith('/ws/a', ['mod', 'edit', '-droprequire=github.com/spf13/cobra']);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('prefers the /vN module over the unversioned one', async () => {
    const { actions, run } = setup([parsed('a', ['github.com/x/m', 'github.com/x/m/v2'])]);
    await actions.uninstall('github.com/x/m/v2/sub');
    expect(run).toHaveBeenCalledWith('/ws/a', ['mod', 'edit', '-droprequire=github.com/x/m/v2']);
  });

  it('offers only the folders that require the module', async () => {
    const { actions, pickFolder, run } = setup([
      parsed('a', ['github.com/x/m']),
      parsed('b', ['github.com/other/o']),
      parsed('c', ['github.com/x/m']),
    ]);
    pickFolder.mockImplementation((candidates: readonly ActionCandidate[]) => Promise.resolve(candidates[0]));
    await actions.uninstall('github.com/x/m');
    expect(pickFolder.mock.calls[0]![0].map((c) => c.goModPath)).toEqual(['/ws/a/go.mod', '/ws/c/go.mod']);
    expect(run).toHaveBeenCalledWith('/ws/a', ['mod', 'edit', '-droprequire=github.com/x/m']);
  });

  it('reports a package no go.mod requires, without running Go', async () => {
    const { actions, run, refresh } = setup([parsed('a', ['github.com/x/m'])]);
    await expect(actions.uninstall('github.com/x/other')).resolves.toEqual({ ok: false, error: notRequired('github.com/x/other') });
    expect(run).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('maps a failure to a message and still refreshes', async () => {
    const { actions, refresh } = setup([parsed('a', ['github.com/x/m'])], { ok: false, reason: 'failed', output: 'bad' });
    await expect(actions.uninstall('github.com/x/m')).resolves.toEqual({ ok: false, error: goFailed('uninstall', 'bad') });
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('PackageActions logging', () => {
  it('writes the start and the result with Go output indented', async () => {
    const { actions, output } = setup([parsed('a', [])], { ok: true, output: 'go: added github.com/spf13/cobra v1.8.0\n' });
    await actions.install('github.com/spf13/cobra');
    expect(output.lines).toHaveLength(2);
    expect(output.lines[0]).toContain('running "go get -- github.com/spf13/cobra" in /ws/a');
    expect(output.lines[1]).toContain('done\n    go: added github.com/spf13/cobra v1.8.0');
  });
});
