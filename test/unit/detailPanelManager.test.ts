import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DetailController } from '../../src/core/detailController';
import { EMPTY_DETAIL_STATE } from '../../src/core/detailProtocol';
import { DetailPanelManager, type PanelLike } from '../../src/vscode/detailPanelManager';
import { FakeSearchClient, RecordingOutput, flushPromises } from './searchArbitraries';
import { FakeTimers } from './fakeTimers';
import { EventEmitter, Uri, type Disposable } from './vscodeStub';

const SFTP = readFileSync(join(__dirname, '..', 'fixtures', 'package-detail', 'sftp-sample.html'), 'utf8');
const SFTP_PATH = 'github.com/pkg/sftp/v2';
const OTHER_PATH = 'github.com/spf13/cobra';

class FakePanel {
  readonly posted: any[] = [];
  readonly revealCalls: unknown[][] = [];
  title = 'Package details';
  iconPath: unknown;
  disposeCalls = 0;
  receiveListeners = 0;
  private readonly received = new EventEmitter<unknown>();
  private readonly disposed = new EventEmitter<void>();

  readonly webview = {
    options: undefined as unknown,
    html: '',
    cspSource: 'vscode-webview-resource:',
    asWebviewUri: (uri: Uri): Uri => uri,
    postMessage: (message: unknown): Promise<boolean> => {
      this.posted.push(message);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: (listener: (e: unknown) => unknown): Disposable => {
      this.receiveListeners++;
      const subscription = this.received.event(listener);
      return {
        dispose: () => {
          this.receiveListeners--;
          subscription.dispose();
        },
      };
    },
  };

  reveal(...args: unknown[]): void {
    this.revealCalls.push(args);
  }

  onDidDispose(listener: () => unknown): Disposable {
    return this.disposed.event(listener);
  }

  dispose(): void {
    this.disposeCalls++;
    this.disposed.fire();
  }

  send(message: unknown): void {
    this.received.fire(message);
  }

  get asPanel(): PanelLike {
    return this as unknown as PanelLike;
  }
}

function setup() {
  const actionCalls: string[] = [];
  const actions = {
    install: (path: string) => {
      actionCalls.push(`install ${path}`);
      return new Promise<never>(() => undefined);
    },
    uninstall: (path: string) => {
      actionCalls.push(`uninstall ${path}`);
      return new Promise<never>(() => undefined);
    },
  };
  const client = new FakeSearchClient();
  const output = new RecordingOutput();
  const controller = new DetailController({
    client,
    output,
    timers: new FakeTimers(),
    isInstalled: () => false,
    actions,
  });
  const panels: FakePanel[] = [];
  const mediaRoots: Uri[] = [];
  const opened: string[] = [];
  const manager = new DetailPanelManager(
    Uri.file('/ext') as never,
    controller,
    (url) => {
      opened.push(url);
      return Promise.resolve(true);
    },
    (mediaRoot) => {
      mediaRoots.push(mediaRoot as never);
      const panel = new FakePanel();
      panels.push(panel);
      return panel.asPanel;
    },
  );
  return { client, output, controller, manager, panels, mediaRoots, opened, actionCalls };
}

describe('DetailPanelManager', () => {
  it('creates exactly one panel on the first show() and loads the path', () => {
    const { manager, panels, mediaRoots, client, controller } = setup();
    expect(manager.isOpen).toBe(false);
    manager.show(SFTP_PATH);
    expect(panels).toHaveLength(1);
    expect(manager.isOpen).toBe(true);
    expect(mediaRoots.map((u) => u.toString())).toEqual(['file:///ext/media']);
    expect(panels[0]!.revealCalls).toEqual([]);
    expect(panels[0]!.webview.html).toContain('id="detail-main"');
    expect(panels[0]!.webview.html).toContain('/ext/media/detail.js');
    expect(panels[0]!.webview.html).toContain('/ext/media/detail.css');
    expect(panels[0]!.iconPath).toBeDefined();
    expect(client.calls.map((c) => c.url)).toEqual([`https://pkg.go.dev/${SFTP_PATH}`]);
    expect(controller.state.status).toBe('loading');
  });

  it('re-uses the panel for another path and reveals it without stealing focus', () => {
    const { manager, panels, client, controller } = setup();
    manager.show(SFTP_PATH);
    manager.show(OTHER_PATH);
    expect(panels).toHaveLength(1);
    expect(panels[0]!.revealCalls).toEqual([[undefined, true]]);
    expect(client.calls.map((c) => c.url)).toEqual([
      `https://pkg.go.dev/${SFTP_PATH}`,
      `https://pkg.go.dev/${OTHER_PATH}`,
    ]);
    expect(controller.state).toMatchObject({ status: 'loading', path: OTHER_PATH });
  });

  it('posts the snapshot on ready and every controller change afterwards, and titles the tab', async () => {
    const { manager, panels, client } = setup();
    manager.show(SFTP_PATH);
    const panel = panels[0]!;
    expect(panel.posted.map((m) => m.state?.status)).toEqual(['loading']);
    expect(panel.title).toBe('GoGet: sftp');

    panel.send({ type: 'ready' });
    expect(panel.posted).toHaveLength(2);
    expect(panel.posted[1]).toMatchObject({ type: 'state', state: { status: 'loading', path: SFTP_PATH } });

    client.calls[0]!.settle({ kind: 'ok', html: SFTP });
    await flushPromises();
    expect(panel.posted[panel.posted.length - 1]).toMatchObject({ type: 'state', state: { status: 'ready' } });
    expect(panel.title).toBe('GoGet: sftp');
  });

  it('titles the tab with the package name, not the import path', () => {
    const { manager, panels } = setup();
    manager.show(OTHER_PATH);
    expect(panels[0]!.title).toBe('GoGet: cobra');
  });

  it('routes changeGoos, retry, install and uninstall to the controller', async () => {
    const { manager, panels, client, actionCalls } = setup();
    manager.show(SFTP_PATH);
    client.calls[0]!.settle({ kind: 'ok', html: SFTP });
    await flushPromises();
    const panel = panels[0]!;

    panel.send({ type: 'changeGoos', goos: 'linux' });
    expect(client.calls[1]!.url).toBe(`https://pkg.go.dev/${SFTP_PATH}?GOOS=linux`);

    client.calls[1]!.settle({ kind: 'failed', failure: { kind: 'http', status: 500 } });
    await flushPromises();
    panel.send({ type: 'retry' });
    expect(client.calls[2]!.url).toBe(`https://pkg.go.dev/${SFTP_PATH}?GOOS=linux`);

    panel.send({ type: 'install' });
    expect(actionCalls).toEqual([`install ${SFTP_PATH}`]);
    expect(panel.posted[panel.posted.length - 1]).toEqual({ type: 'action', installed: false, busy: 'install' });
  });

  it('opens links externally only for valid messages', () => {
    const { manager, panels, opened } = setup();
    manager.show(SFTP_PATH);
    const panel = panels[0]!;
    panel.send({ type: 'openLink', url: 'https://go.dev/doc' });
    panel.send({ type: 'openLink', url: 'javascript:alert(1)' });
    panel.send({ type: 'openLink', url: 5 });
    panel.send({ type: 'openLink' });
    expect(opened).toEqual(['https://go.dev/doc']);
  });

  it('swallows a failing openExternal', async () => {
    const client = new FakeSearchClient();
    const controller = new DetailController({
      client,
      output: new RecordingOutput(),
      isInstalled: () => false,
      actions: { install: () => Promise.resolve({ ok: true }), uninstall: () => Promise.resolve({ ok: true }) },
    });
    const panel = new FakePanel();
    const manager = new DetailPanelManager(
      Uri.file('/ext') as never,
      controller,
      () => Promise.reject(new Error('no browser')),
      () => panel.asPanel,
    );
    manager.show(SFTP_PATH);
    panel.send({ type: 'openLink', url: 'https://go.dev/doc' });
    await flushPromises();
    expect(manager.isOpen).toBe(true);
    controller.dispose();
  });

  it('ignores invalid messages', () => {
    const { manager, panels, client, controller, output } = setup();
    manager.show(SFTP_PATH);
    const panel = panels[0]!;
    const postedBefore = panel.posted.length;
    for (const bad of [undefined, null, 5, 'ready', [], {}, { type: 'nope' }, { type: 'changeGoos', goos: 'Win dows' }]) {
      panel.send(bad);
    }
    expect(panel.posted).toHaveLength(postedBefore);
    expect(client.calls).toHaveLength(1);
    expect(controller.state.status).toBe('loading');
    expect(output.lines).toEqual([]);
  });

  it('clears the reference on dispose, resets the controller and opens a new panel next time', () => {
    const { manager, panels, controller, client } = setup();
    manager.show(SFTP_PATH);
    const first = panels[0]!;
    first.dispose();
    expect(manager.isOpen).toBe(false);
    expect(first.receiveListeners).toBe(0);
    expect(controller.state).toBe(EMPTY_DETAIL_STATE);
    expect(client.calls[0]!.aborted).toBe(true);

    manager.show(SFTP_PATH);
    expect(panels).toHaveLength(2);
    expect(panels[1]).not.toBe(first);
    expect(panels[1]!.revealCalls).toEqual([]);
    expect(client.calls).toHaveLength(2);
    expect(first.posted[first.posted.length - 1]).toMatchObject({ type: 'state' });
  });

  it('dispose() disposes the panel and stops listening', () => {
    const { manager, panels, controller } = setup();
    manager.show(SFTP_PATH);
    const panel = panels[0]!;
    const posted = panel.posted.length;
    manager.dispose();
    expect(panel.disposeCalls).toBe(1);
    expect(manager.isOpen).toBe(false);
    controller.show(OTHER_PATH);
    expect(panel.posted).toHaveLength(posted);
  });
});
