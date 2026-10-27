import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetailController } from '../../src/core/detailController';
import type { ActionResult } from '../../src/core/packageActions';
import { EMPTY_DETAIL_STATE, type HostToDetail } from '../../src/core/detailProtocol';
import {
  DETAIL_BAD_PAGE,
  DETAIL_INVALID_PATH,
  DETAIL_NOT_FOUND,
  DETAIL_TIMED_OUT,
  UNREACHABLE,
  httpError,
  installNotRecorded,
} from '../../src/core/messages';
import { FakeSearchClient, RecordingOutput, FIXED_TIMESTAMP, fixedClock, flushPromises } from './searchArbitraries';
import { FakeTimers } from './fakeTimers';

const FIXTURES = join(__dirname, '..', 'fixtures', 'package-detail');
const SFTP = readFileSync(join(FIXTURES, 'sftp-sample.html'), 'utf8');
const COBRA = readFileSync(join(FIXTURES, 'live-style.html'), 'utf8');

const SFTP_PATH = 'github.com/pkg/sftp/v2';
const COBRA_PATH = 'github.com/spf13/cobra';

interface Harness {
  readonly controller: DetailController;
  readonly client: FakeSearchClient;
  readonly output: RecordingOutput;
  readonly timers: FakeTimers;
  readonly messages: HostToDetail[];
  readonly actionCalls: { kind: 'install' | 'uninstall'; path: string; settle: (result: ActionResult) => void }[];
  installed: Set<string>;
}

function setup(timeoutMs?: number): Harness {
  const client = new FakeSearchClient();
  const output = new RecordingOutput();
  const timers = new FakeTimers();
  const h: Harness = {
    client,
    output,
    timers,
    messages: [],
    actionCalls: [],
    installed: new Set(),
    controller: undefined as never,
  };
  (h as { controller: DetailController }).controller = new DetailController({
    client,
    output,
    timers,
    now: fixedClock,
    isInstalled: (path) => h.installed.has(path),
    actions: {
      install: (path) => new Promise((resolve) => h.actionCalls.push({ kind: 'install', path, settle: resolve })),
      uninstall: (path) => new Promise((resolve) => h.actionCalls.push({ kind: 'uninstall', path, settle: resolve })),
    },
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  h.controller.onDidChange((m) => h.messages.push(m));
  return h;
}

async function settleOk(h: Harness, call: number, html: string): Promise<void> {
  h.client.calls[call]!.settle({ kind: 'ok', html });
  await flushPromises();
}

async function loadSftp(h: Harness): Promise<void> {
  h.controller.show(SFTP_PATH);
  await settleOk(h, h.client.calls.length - 1, SFTP);
}

describe('DetailController show', () => {
  it('starts idle', () => {
    const h = setup();
    expect(h.controller.state).toBe(EMPTY_DETAIL_STATE);
    expect(h.controller.snapshot()).toEqual({ type: 'state', state: EMPTY_DETAIL_STATE });
  });

  it('emits loading synchronously, then ready with goos and installed', async () => {
    const h = setup();
    h.installed.add(SFTP_PATH);
    h.controller.show(SFTP_PATH);
    expect(h.messages).toEqual([
      { type: 'state', state: { status: 'loading', path: SFTP_PATH, installed: false, mainLoading: false } },
    ]);
    expect(h.client.calls.map((c) => c.url)).toEqual([`https://pkg.go.dev/${SFTP_PATH}`]);

    await settleOk(h, 0, SFTP);
    const state = h.controller.state;
    expect(state.status).toBe('ready');
    expect(state.path).toBe(SFTP_PATH);
    expect(state.detail?.title).toBe('sftp');
    expect(state.goos).toBe('windows');
    expect(state.installed).toBe(true);
    expect(state.mainLoading).toBe(false);
    expect(state.error).toBeUndefined();
    expect(h.messages).toHaveLength(2);
    expect(h.timers.pendingCount).toBe(0);
  });

  it('uses the first GOOS option when the page has no selected option', async () => {
    const h = setup();
    h.controller.show(COBRA_PATH);
    await settleOk(h, 0, COBRA);
    expect(h.controller.state.goos).toBe('linux');
    expect(h.controller.state.installed).toBe(false);
  });

  it('reports an invalid path without fetching', () => {
    const h = setup();
    h.controller.show('../etc/passwd');
    expect(h.client.calls).toHaveLength(0);
    expect(h.controller.state).toMatchObject({ status: 'error', error: DETAIL_INVALID_PATH });
  });

  it('does not refetch the same path while loading or ready', async () => {
    const h = setup();
    h.controller.show(SFTP_PATH);
    h.controller.show(SFTP_PATH);
    expect(h.client.calls).toHaveLength(1);
    await settleOk(h, 0, SFTP);
    h.controller.show(SFTP_PATH);
    expect(h.client.calls).toHaveLength(1);
    expect(h.controller.state.status).toBe('ready');
  });

  it('refetches the same path after an error, via show and via retry', async () => {
    const h = setup();
    h.controller.show(SFTP_PATH);
    h.client.calls[0]!.settle({ kind: 'failed', failure: { kind: 'unreachable', reason: 'ENOTFOUND' } });
    await flushPromises();
    expect(h.controller.state).toMatchObject({ status: 'error', path: SFTP_PATH, error: UNREACHABLE });

    h.controller.show(SFTP_PATH);
    expect(h.client.calls).toHaveLength(2);
    expect(h.controller.state.status).toBe('loading');
    h.client.calls[1]!.settle({ kind: 'failed', failure: { kind: 'http', status: 500 } });
    await flushPromises();
    expect(h.controller.state).toMatchObject({ status: 'error', error: httpError(500) });

    h.controller.retry();
    expect(h.client.calls).toHaveLength(3);
    await settleOk(h, 2, SFTP);
    expect(h.controller.state.status).toBe('ready');
  });

  it('ignores a stale response when a newer show() started and aborts the old request', async () => {
    const h = setup();
    h.controller.show(SFTP_PATH);
    h.controller.show(COBRA_PATH);
    expect(h.client.calls).toHaveLength(2);
    expect(h.client.calls[0]!.aborted).toBe(true);
    expect(h.client.calls[1]!.aborted).toBe(false);

    await settleOk(h, 0, SFTP);
    expect(h.controller.state).toMatchObject({ status: 'loading', path: COBRA_PATH });

    await settleOk(h, 1, COBRA);
    expect(h.controller.state).toMatchObject({ status: 'ready', path: COBRA_PATH });
    expect(h.controller.state.detail?.title).toBe('cobra');
  });

  it('maps failures to messages and writes one log line each', async () => {
    const cases: [Parameters<FakeSearchClient['calls'][number]['settle']>[0], string, string][] = [
      [{ kind: 'failed', failure: { kind: 'unreachable', reason: 'ECONNRESET' } }, UNREACHABLE, 'unreachable (ECONNRESET)'],
      [{ kind: 'failed', failure: { kind: 'http', status: 404 } }, DETAIL_NOT_FOUND, 'HTTP error 404'],
      [{ kind: 'failed', failure: { kind: 'http', status: 503 } }, httpError(503), 'HTTP error 503'],
      [
        { kind: 'failed', failure: { kind: 'redirectBlocked', status: 302, targetHost: 'evil.test' } },
        httpError(302),
        'redirect to host evil.test blocked',
      ],
      [{ kind: 'ok', html: '<html></html>' }, DETAIL_BAD_PAGE, 'unrecognised page'],
    ];
    for (const [response, message, logText] of cases) {
      const h = setup();
      h.controller.show(SFTP_PATH);
      h.client.calls[0]!.settle(response);
      await flushPromises();
      expect(h.controller.state).toMatchObject({ status: 'error', path: SFTP_PATH, error: message });
      expect(h.output.lines).toHaveLength(1);
      expect(h.output.lines[0]).toContain(`[${FIXED_TIMESTAMP}]`);
      expect(h.output.lines[0]).toContain(JSON.stringify(SFTP_PATH));
      expect(h.output.lines[0]).toContain(logText);
    }
  });

  it('times out, aborts the request and reports DETAIL_TIMED_OUT', async () => {
    const h = setup(1000);
    h.controller.show(SFTP_PATH);
    h.timers.advance(999);
    expect(h.controller.state.status).toBe('loading');
    h.timers.advance(1);
    expect(h.client.calls[0]!.aborted).toBe(true);
    expect(h.controller.state).toMatchObject({ status: 'error', error: DETAIL_TIMED_OUT });
    expect(h.output.lines).toHaveLength(1);
    expect(h.output.lines[0]).toContain('timeout');
    await settleOk(h, 0, SFTP);
    expect(h.controller.state.status).toBe('error');
  });

  it('treats a rejecting client as unreachable', async () => {
    const h = setup();
    (h.client as { search: unknown }).search = () => Promise.reject(Object.assign(new Error('boom'), { code: 'EBOOM' }));
    h.controller.show(SFTP_PATH);
    await flushPromises();
    expect(h.controller.state).toMatchObject({ status: 'error', error: UNREACHABLE });
    expect(h.output.lines[0]).toContain('EBOOM');
  });
});

describe('DetailController changeGoos', () => {
  it('shows main-only loading, requests ?GOOS and replaces the detail', async () => {
    const h = setup();
    await loadSftp(h);
    const before = h.controller.state.detail;
    h.messages.length = 0;

    h.controller.changeGoos('linux');
    expect(h.client.calls[1]!.url).toBe(`https://pkg.go.dev/${SFTP_PATH}?GOOS=linux`);
    expect(h.controller.state).toMatchObject({ status: 'ready', mainLoading: true, goos: 'windows' });
    expect(h.controller.state.detail).toBe(before);

    await settleOk(h, 1, COBRA);
    expect(h.controller.state.mainLoading).toBe(false);
    expect(h.controller.state.detail).not.toBe(before);
    expect(h.controller.state.goos).toBe('linux');
    expect(h.controller.state.status).toBe('ready');
    expect(h.messages.map((m) => m.type)).toEqual(['state', 'state']);
  });

  it('keeps the old detail with an inline error on failure, and retry repeats the GOOS request', async () => {
    const h = setup();
    await loadSftp(h);
    const before = h.controller.state.detail;

    h.controller.changeGoos('darwin');
    h.client.calls[1]!.settle({ kind: 'failed', failure: { kind: 'unreachable', reason: 'x' } });
    await flushPromises();
    expect(h.controller.state).toMatchObject({ status: 'ready', mainLoading: false, error: UNREACHABLE, goos: 'windows' });
    expect(h.controller.state.detail).toBe(before);
    expect(h.output.lines).toHaveLength(1);
    expect(h.output.lines[0]).toContain('GOOS=darwin');

    h.controller.retry();
    expect(h.client.calls[2]!.url).toBe(`https://pkg.go.dev/${SFTP_PATH}?GOOS=darwin`);
    expect(h.controller.state).toMatchObject({ mainLoading: true });
    expect(h.controller.state.error).toBeUndefined();
    await settleOk(h, 2, SFTP);
    expect(h.controller.state.error).toBeUndefined();
    expect(h.controller.state.mainLoading).toBe(false);
  });

  it('ignores a GOOS that is not an option, when idle, loading, or when the page has no GOOS select', async () => {
    const h = setup();
    h.controller.changeGoos('linux');
    h.controller.show(SFTP_PATH);
    h.controller.changeGoos('linux');
    expect(h.client.calls).toHaveLength(1);
    await settleOk(h, 0, SFTP);
    h.controller.changeGoos('plan9');
    h.controller.changeGoos('Linux');
    expect(h.client.calls).toHaveLength(1);

    const g = setup();
    g.controller.show('github.com/pkg/errors');
    await settleOk(g, 0, COBRA.replace(/<select[\s\S]*?<\/select>/u, ''));
    expect(g.controller.state.detail?.buildContext).toBeUndefined();
    g.controller.changeGoos('linux');
    expect(g.client.calls).toHaveLength(1);
  });

  it('ignores the response of a GOOS request after a newer show()', async () => {
    const h = setup();
    await loadSftp(h);
    h.controller.changeGoos('linux');
    h.controller.show(COBRA_PATH);
    expect(h.client.calls[1]!.aborted).toBe(true);
    await settleOk(h, 1, SFTP);
    expect(h.controller.state).toMatchObject({ status: 'loading', path: COBRA_PATH });
  });
});

describe('DetailController installed flag', () => {
  it('emits installed only when the flag changed', async () => {
    const h = setup();
    await loadSftp(h);
    h.messages.length = 0;

    h.controller.refreshInstalled();
    expect(h.messages).toEqual([]);

    h.installed.add(SFTP_PATH);
    h.controller.refreshInstalled();
    expect(h.messages).toEqual([{ type: 'installed', installed: true }]);
    expect(h.controller.state.installed).toBe(true);

    h.controller.refreshInstalled();
    expect(h.messages).toHaveLength(1);

    h.installed.clear();
    h.controller.refreshInstalled();
    expect(h.messages[1]).toEqual({ type: 'installed', installed: false });
  });

  it('is a no-op when idle or loading', () => {
    const h = setup();
    h.installed.add(SFTP_PATH);
    h.controller.refreshInstalled();
    h.controller.show(SFTP_PATH);
    h.messages.length = 0;
    h.controller.refreshInstalled();
    expect(h.messages).toEqual([]);
  });

  it('treats a throwing isInstalled as not installed', async () => {
    const h = setup();
    const controller = new DetailController({
      client: h.client,
      output: h.output,
      timers: h.timers,
      isInstalled: () => {
        throw new Error('nope');
      },
      actions: { install: () => Promise.resolve({ ok: true }), uninstall: () => Promise.resolve({ ok: true }) },
    });
    controller.show(SFTP_PATH);
    await settleOk(h, 0, SFTP);
    expect(controller.state).toMatchObject({ status: 'ready', installed: false });
  });
});

async function settleAction(h: Harness, call: number, result: ActionResult): Promise<void> {
  h.actionCalls[call]!.settle(result);
  await flushPromises();
}

describe('DetailController install/uninstall', () => {
  it('install goes busy synchronously, runs once, and ignores a second click', async () => {
    const h = setup();
    await loadSftp(h);
    h.messages.length = 0;

    h.controller.requestInstall();
    expect(h.messages).toEqual([{ type: 'action', installed: false, busy: 'install' }]);
    expect(h.controller.state.busy).toBe('install');
    h.controller.requestInstall();
    h.controller.requestUninstall();
    expect(h.actionCalls).toHaveLength(1);
    expect(h.actionCalls[0]).toMatchObject({ kind: 'install', path: SFTP_PATH });
    expect(h.messages).toHaveLength(1);
  });

  it('install success re-reads go.mod state and clears busy', async () => {
    const h = setup();
    await loadSftp(h);
    h.controller.requestInstall();
    h.messages.length = 0;
    h.installed.add(SFTP_PATH);
    await settleAction(h, 0, { ok: true });
    expect(h.messages).toEqual([{ type: 'action', installed: true }]);
    expect(h.controller.state).toMatchObject({ installed: true });
    expect(h.controller.state.busy).toBeUndefined();
    expect(h.controller.state.actionError).toBeUndefined();
  });

  it('install failure shows the error and leaves the installed flag alone', async () => {
    const h = setup();
    await loadSftp(h);
    h.controller.requestInstall();
    h.messages.length = 0;
    await settleAction(h, 0, { ok: false, error: 'boom' });
    expect(h.messages).toEqual([{ type: 'action', installed: false, error: 'boom' }]);
    expect(h.controller.state).toMatchObject({ installed: false, actionError: 'boom' });
    expect(h.controller.state.busy).toBeUndefined();

    h.controller.requestInstall();
    expect(h.controller.state.actionError).toBeUndefined();
    expect(h.actionCalls).toHaveLength(2);
  });

  it('install that did not change go.mod reports it', async () => {
    const h = setup();
    await loadSftp(h);
    h.controller.requestInstall();
    await settleAction(h, 0, { ok: true });
    expect(h.controller.state).toMatchObject({ installed: false, actionError: installNotRecorded(SFTP_PATH) });
  });

  it('a cancelled install shows nothing', async () => {
    const h = setup();
    await loadSftp(h);
    h.controller.requestInstall();
    h.messages.length = 0;
    await settleAction(h, 0, { ok: false, cancelled: true });
    expect(h.messages).toEqual([{ type: 'action', installed: false }]);
    expect(h.controller.state.actionError).toBeUndefined();
  });

  it('uninstall mirrors install, and contradicting requests are ignored', async () => {
    const h = setup();
    h.installed.add(SFTP_PATH);
    await loadSftp(h);
    h.controller.requestInstall();
    expect(h.actionCalls).toHaveLength(0);

    h.controller.requestUninstall();
    expect(h.controller.state.busy).toBe('uninstall');
    expect(h.actionCalls[0]).toMatchObject({ kind: 'uninstall', path: SFTP_PATH });
    h.messages.length = 0;
    h.installed.clear();
    await settleAction(h, 0, { ok: true });
    expect(h.messages).toEqual([{ type: 'action', installed: false }]);

    h.controller.requestUninstall();
    expect(h.actionCalls).toHaveLength(1);
  });

  it('a rejecting action becomes an error', async () => {
    const h = setup();
    const controller = new DetailController({
      client: h.client,
      output: h.output,
      timers: h.timers,
      isInstalled: () => false,
      actions: { install: () => Promise.reject(new Error('kaput')), uninstall: () => Promise.resolve({ ok: true }) },
    });
    controller.show(SFTP_PATH);
    await settleOk(h, 0, SFTP);
    controller.requestInstall();
    await flushPromises();
    expect(controller.state.busy).toBeUndefined();
    expect(controller.state.actionError).toContain('kaput');
  });

  it('busy survives switching away and back', async () => {
    const h = setup();
    await loadSftp(h);
    h.controller.requestInstall();

    h.controller.show(COBRA_PATH);
    await settleOk(h, 1, COBRA);
    expect(h.controller.state.busy).toBeUndefined();
    h.controller.show(SFTP_PATH);
    await settleOk(h, 2, SFTP);
    expect(h.controller.state.busy).toBe('install');
    h.controller.requestInstall();
    expect(h.actionCalls).toHaveLength(1);

    h.messages.length = 0;
    h.installed.add(SFTP_PATH);
    await settleAction(h, 0, { ok: true });
    expect(h.messages).toEqual([{ type: 'action', installed: true }]);
  });

  it('finishing after the user moved on emits nothing', async () => {
    const h = setup();
    await loadSftp(h);
    h.controller.requestInstall();
    h.controller.show(COBRA_PATH);
    await settleOk(h, 1, COBRA);
    h.messages.length = 0;
    await settleAction(h, 0, { ok: true });
    expect(h.messages).toEqual([]);
  });

  it('reset mid-action emits nothing when the action settles', async () => {
    const h = setup();
    await loadSftp(h);
    h.controller.requestInstall();
    h.controller.reset();
    h.messages.length = 0;
    await settleAction(h, 0, { ok: true });
    expect(h.messages).toEqual([]);
    expect(h.controller.state).toBe(EMPTY_DETAIL_STATE);
  });

  it('dispose mid-action emits nothing when the action settles', async () => {
    const h = setup();
    await loadSftp(h);
    h.controller.requestInstall();
    h.controller.dispose();
    h.messages.length = 0;
    await settleAction(h, 0, { ok: true });
    expect(h.messages).toEqual([]);
  });
});

describe('DetailController reset and dispose', () => {
  it('reset aborts in-flight work and returns to idle', async () => {
    const h = setup();
    h.controller.show(SFTP_PATH);
    h.controller.reset();
    expect(h.client.calls[0]!.aborted).toBe(true);
    expect(h.controller.state).toBe(EMPTY_DETAIL_STATE);
    expect(h.messages[h.messages.length - 1]).toEqual({ type: 'state', state: EMPTY_DETAIL_STATE });
    await settleOk(h, 0, SFTP);
    expect(h.controller.state).toBe(EMPTY_DETAIL_STATE);
    expect(h.timers.pendingCount).toBe(0);

    h.controller.show(SFTP_PATH);
    expect(h.client.calls).toHaveLength(2);
  });

  it('dispose silences emissions and ignores later calls', async () => {
    const h = setup();
    h.controller.show(SFTP_PATH);
    const count = h.messages.length;
    h.controller.dispose();
    expect(h.client.calls[0]!.aborted).toBe(true);
    await settleOk(h, 0, SFTP);
    h.controller.show(COBRA_PATH);
    h.controller.reset();
    h.controller.refreshInstalled();
    h.controller.requestInstall();
    expect(h.messages).toHaveLength(count);
    expect(h.client.calls).toHaveLength(1);
    expect(h.output.lines).toEqual([]);
  });

  it('survives a throwing listener', async () => {
    const h = setup();
    h.controller.onDidChange(() => {
      throw new Error('listener');
    });
    h.controller.show(SFTP_PATH);
    await settleOk(h, 0, SFTP);
    expect(h.controller.state.status).toBe('ready');
    expect(h.output.lines.some((line) => line.includes('Listener failed'))).toBe(true);
  });
});
