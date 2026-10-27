import { describe, expect, it } from 'vitest';
import { EMPTY_VIEW_MODEL } from '../../src/core/searchProtocol';
import { SearchViewProvider, buildSearchHtml } from '../../src/vscode/searchViewProvider';
import {
  createControllerHarness,
  flushPromises,
  plainPage,
  renderPage,
  type ControllerHarness,
  type EntrySpec,
} from './searchArbitraries';
import { EventEmitter, Uri, type Disposable } from './vscodeStub';

const MONGO: EntrySpec = {
  name: 'mongo',
  path: 'go.mongodb.org/mongo-driver/v2/mongo',
  synopsis: 'Package mongo provides a MongoDB Driver API for Go.',
  version: 'v2.0.0',
  published: 'Oct 6, 2026',
  importedBy: '1,289',
};
const MGO: EntrySpec = { ...MONGO, name: 'mgo', path: 'gopkg.in/mgo.v2' };
const PAGE = renderPage(plainPage([MONGO, MGO]));

type ResolvedView = Parameters<SearchViewProvider['resolveWebviewView']>[0];

/** The parts of `vscode.WebviewView` the provider touches, with call recording. */
class FakeWebviewView {
  visible = true;
  readonly cspSource = 'vscode-webview-resource:';
  readonly posted: any[] = [];
  private readonly received = new EventEmitter<unknown>();
  private readonly disposed = new EventEmitter<void>();
  receiveListeners = 0;
  disposeListeners = 0;

  readonly webview = {
    cspSource: this.cspSource,
    options: undefined as unknown,
    html: '',
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

  readonly onDidDispose = (listener: () => unknown): Disposable => {
    this.disposeListeners++;
    const subscription = this.disposed.event(listener);
    return {
      dispose: () => {
        this.disposeListeners--;
        subscription.dispose();
      },
    };
  };

  /** The webview posts a message to the host. */
  send(message: unknown): void {
    this.received.fire(message);
  }

  /** VS Code disposes the view. */
  dispose(): void {
    this.disposed.fire();
  }

  get states(): any[] {
    return this.posted.map((m) => m.state);
  }

  get lastState(): any {
    return this.posted[this.posted.length - 1]?.state;
  }

  get asView(): ResolvedView {
    return this as unknown as ResolvedView;
  }
}

function setup(): { h: ControllerHarness; provider: SearchViewProvider; view: FakeWebviewView } {
  const h = createControllerHarness();
  const provider = new SearchViewProvider(Uri.file('/ext') as never, h.controller);
  const view = new FakeWebviewView();
  provider.resolveWebviewView(view.asView);
  return { h, provider, view };
}

async function settleOk(h: ControllerHarness, callIndex: number, html: string): Promise<void> {
  h.client.calls[callIndex]!.settle({ kind: 'ok', html });
  await flushPromises();
}

describe('buildSearchHtml structure (Req 7.2, 7.4, 8.7)', () => {
  const nonce = 'abc123NONCE==';
  const html = buildSearchHtml('vscode-webview-resource:', nonce, 'media/search.css', 'media/search.js');

  it('has a hidden #loading element', () => {
    const loading = /<[a-z]+\b[^>]*\bid="loading"[^>]*>/.exec(html)?.[0];
    expect(loading).toBeDefined();
    expect(loading).toMatch(/\bhidden\b/);
  });

  it('has a #status live region with role="status" and aria-live="polite"', () => {
    const status = /<[a-z]+\b[^>]*\bid="status"[^>]*>/.exec(html)?.[0];
    expect(status).toBeDefined();
    expect(status).toContain('role="status"');
    expect(status).toContain('aria-live="polite"');
  });

  it('has a #results list', () => {
    expect(/<ul\b[^>]*\bid="results"[^>]*>/.test(html)).toBe(true);
  });

  it('keeps a CSP without connect-src and with the script nonce', () => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1]!;
    expect(csp).not.toContain('connect-src');
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).toContain('img-src data:');
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it('still has exactly one input', () => {
    expect(html.match(/<input\b/g)).toHaveLength(1);
  });
});

describe('SearchViewProvider', () => {
  describe('resolving', () => {
    it('marks the provider resolved and writes the page html', () => {
      const h = createControllerHarness();
      const provider = new SearchViewProvider(Uri.file('/ext') as never, h.controller);
      expect(provider.isResolved).toBe(false);
      const view = new FakeWebviewView();
      provider.resolveWebviewView(view.asView);
      expect(provider.isResolved).toBe(true);
      expect((view.asView as any).webview.html).toContain('id="results"');
    });

    it('posts nothing until the webview sends ready', () => {
      const { view } = setup();
      expect(view.posted).toEqual([]);
    });
  });

  // Requirement 7.6
  describe('ready', () => {
    it('posts the current (empty) state', () => {
      const { view } = setup();
      view.send({ type: 'ready' });
      expect(view.posted).toEqual([{ type: 'state', state: EMPTY_VIEW_MODEL }]);
    });

    it('posts the current results after a search finished', async () => {
      const { h, view } = setup();
      h.controller.submit('mongodb');
      await settleOk(h, 0, PAGE);
      view.posted.length = 0;
      view.send({ type: 'ready' });
      expect(view.posted).toHaveLength(1);
      expect(view.lastState.results.map((r: any) => r.path)).toEqual([MONGO.path, MGO.path]);
      expect(view.lastState.status).toBe('2 results');
      expect(view.lastState.loading).toBe(false);
    });

    it('does not start a search', () => {
      const { h, view } = setup();
      view.send({ type: 'ready' });
      h.timers.advance(60_000);
      expect(h.client.calls).toHaveLength(0);
    });
  });

  // Requirement 8.7
  describe('invalid messages', () => {
    const invalid: unknown[] = [
      undefined,
      null,
      42,
      'ready',
      [],
      {},
      { type: 'nope' },
      { type: 'query' },
      { type: 'query', text: 5 },
      { type: 'submit', text: null },
      { type: 'open', resultsVersion: -1, index: 0 },
      { type: 'open', resultsVersion: 0, index: 1.5 },
      { type: 'open', resultsVersion: '1', index: 0 },
    ];

    it.each(invalid.map((m) => [JSON.stringify(m) ?? 'undefined', m] as const))('ignores %s', async (_label, message) => {
      const { h, view } = setup();
      view.send(message);
      h.timers.advance(60_000);
      await flushPromises();
      expect(view.posted).toEqual([]);
      expect(h.client.calls).toHaveLength(0);
      expect(h.opened).toEqual([]);
      expect(h.errors).toEqual([]);
      expect(h.controller.state).toBe(EMPTY_VIEW_MODEL);
    });
  });

  describe('relaying to the controller', () => {
    it('relays query to queryChanged (debounced search)', () => {
      const { h, view } = setup();
      view.send({ type: 'query', text: 'mongodb' });
      expect(h.client.calls).toHaveLength(0);
      h.timers.advance(400);
      expect(h.client.calls).toHaveLength(1);
      expect(h.client.calls[0]!.url).toBe('https://pkg.go.dev/search?q=mongodb&m=package');
    });

    it('relays an empty query so a pending search is cancelled', () => {
      const { h, view } = setup();
      view.send({ type: 'query', text: 'mongodb' });
      view.send({ type: 'query', text: '' });
      h.timers.advance(400);
      expect(h.client.calls).toHaveLength(0);
    });

    it('relays submit to start a search immediately', () => {
      const { h, view } = setup();
      view.send({ type: 'submit', text: 'mongodb' });
      expect(h.client.calls).toHaveLength(1);
      expect(h.controller.state.loading).toBe(true);
    });

    it('clamps overlong text to 256 code points before it reaches the controller', () => {
      const { h, view } = setup();
      view.send({ type: 'submit', text: 'a'.repeat(300) });
      expect(h.client.calls[0]!.url).toBe(`https://pkg.go.dev/search?q=${'a'.repeat(256)}&m=package`);
    });

    it('relays open and opens the package page of the displayed result', async () => {
      const { h, view } = setup();
      view.send({ type: 'submit', text: 'mongodb' });
      await settleOk(h, 0, PAGE);
      const { resultsVersion } = h.controller.state;
      view.send({ type: 'open', resultsVersion, index: 1 });
      await flushPromises();
      expect(h.opened).toEqual(['https://pkg.go.dev/gopkg.in/mgo.v2']);
    });

    it('ignores open with a stale resultsVersion', async () => {
      const { h, view } = setup();
      view.send({ type: 'submit', text: 'mongodb' });
      await settleOk(h, 0, PAGE);
      const { resultsVersion } = h.controller.state;
      view.send({ type: 'open', resultsVersion: resultsVersion - 1, index: 0 });
      await flushPromises();
      expect(h.opened).toEqual([]);
    });
  });

  describe('state delivery', () => {
    it('posts the loading state and then the outcome', async () => {
      const { h, view } = setup();
      view.send({ type: 'submit', text: 'mongodb' });
      expect(view.lastState).toMatchObject({ loading: true, status: 'Searching…' });
      await settleOk(h, 0, PAGE);
      expect(view.lastState).toMatchObject({ loading: false, status: '2 results' });
      expect(view.posted.every((m) => m.type === 'state')).toBe(true);
    });

    it('posts only the SearchViewModel keys', async () => {
      const { h, view } = setup();
      view.send({ type: 'submit', text: 'mongodb' });
      await settleOk(h, 0, PAGE);
      for (const state of view.states) {
        expect(Object.keys(state).sort()).toEqual(['loading', 'results', 'resultsVersion', 'status']);
      }
    });

    // Requirement 7.5
    it('delivers a state change while the view is hidden', async () => {
      const { h, view } = setup();
      view.visible = false;
      view.send({ type: 'submit', text: 'mongodb' });
      await settleOk(h, 0, PAGE);
      expect(view.lastState.results.map((r: any) => r.path)).toEqual([MONGO.path, MGO.path]);
      expect(view.lastState.status).toBe('2 results');
    });

    it('delivers the outcome of a search that finishes after the view was hidden', async () => {
      const { h, view } = setup();
      view.send({ type: 'submit', text: 'mongodb' });
      view.visible = false;
      await settleOk(h, 0, PAGE);
      view.visible = true;
      expect(view.lastState).toMatchObject({ loading: false, status: '2 results' });
    });

    it('survives a postMessage that rejects', async () => {
      const { h, view } = setup();
      (view.webview as any).postMessage = () => Promise.reject(new Error('disposed'));
      view.send({ type: 'submit', text: 'mongodb' });
      await settleOk(h, 0, PAGE);
      expect(h.controller.state.status).toBe('2 results');
    });
  });

  // Requirements 7.5, 7.6
  describe('re-resolving the view', () => {
    it('gives a re-resolved view that sends ready the outcome of a search that finished meanwhile', async () => {
      const { h, provider, view: first } = setup();
      first.send({ type: 'submit', text: 'mongodb' });
      first.dispose();
      await settleOk(h, 0, PAGE);

      const second = new FakeWebviewView();
      provider.resolveWebviewView(second.asView);
      second.send({ type: 'ready' });

      expect(second.posted).toHaveLength(1);
      expect(second.lastState).toMatchObject({ loading: false, status: '2 results' });
      expect(second.lastState.results.map((r: any) => r.path)).toEqual([MONGO.path, MGO.path]);
    });

    it('gives a view re-resolved while a search is pending the outcome without losing it', async () => {
      const { h, provider, view: first } = setup();
      first.send({ type: 'submit', text: 'mongodb' });

      const second = new FakeWebviewView();
      provider.resolveWebviewView(second.asView);
      await settleOk(h, 0, PAGE);

      expect(second.lastState).toMatchObject({ loading: false, status: '2 results' });
      second.posted.length = 0;
      second.send({ type: 'ready' });
      expect(second.lastState).toMatchObject({ loading: false, status: '2 results' });
    });

    it('stops posting to the previous view once a new one is resolved', async () => {
      const { h, provider, view: first } = setup();
      const second = new FakeWebviewView();
      provider.resolveWebviewView(second.asView);
      h.controller.submit('mongodb');
      await settleOk(h, 0, PAGE);
      expect(first.posted).toEqual([]);
      expect(second.posted.length).toBeGreaterThan(0);
    });

    it('stops relaying messages from the previous view', () => {
      const { h, provider, view: first } = setup();
      provider.resolveWebviewView(new FakeWebviewView().asView);
      first.send({ type: 'submit', text: 'mongodb' });
      expect(h.client.calls).toHaveLength(0);
      expect(first.posted).toEqual([]);
    });
  });

  describe('subscriptions', () => {
    it('subscribes once per resolve to messages, controller state, and view disposal', () => {
      const { h, view } = setup();
      expect(view.receiveListeners).toBe(1);
      expect(view.disposeListeners).toBe(1);
      view.send({ type: 'submit', text: 'mongodb' });
      expect(view.posted).toHaveLength(1); // exactly one controller listener (plus the test's own)
      expect(h.states).toHaveLength(1);
    });

    it('disposes all subscriptions when the view is disposed', async () => {
      const { h, view } = setup();
      view.dispose();
      expect(view.receiveListeners).toBe(0);
      expect(view.disposeListeners).toBe(0);

      h.controller.submit('mongodb');
      await settleOk(h, 0, PAGE);
      expect(view.posted).toEqual([]);

      view.send({ type: 'submit', text: 'other' });
      expect(h.client.calls).toHaveLength(1);
    });

    it('disposes the previous subscriptions when the view is re-resolved', () => {
      const { provider, view: first } = setup();
      const second = new FakeWebviewView();
      provider.resolveWebviewView(second.asView);
      expect(first.receiveListeners).toBe(0);
      expect(first.disposeListeners).toBe(0);
      expect(second.receiveListeners).toBe(1);
      expect(second.disposeListeners).toBe(1);
    });

    it('does not accumulate controller listeners across many re-resolves', () => {
      const { h, provider } = setup();
      const last = new FakeWebviewView();
      for (let i = 0; i < 5; i++) {
        provider.resolveWebviewView(new FakeWebviewView().asView);
      }
      provider.resolveWebviewView(last.asView);
      h.controller.submit('mongodb');
      expect(last.posted).toHaveLength(1);
    });

    it('disposes everything when the provider is disposed', async () => {
      const { h, provider, view } = setup();
      provider.dispose();
      expect(view.receiveListeners).toBe(0);
      expect(view.disposeListeners).toBe(0);
      h.controller.submit('mongodb');
      await settleOk(h, 0, PAGE);
      expect(view.posted).toEqual([]);
    });

    it('tolerates dispose being called twice', () => {
      const { provider, view } = setup();
      view.dispose();
      expect(() => {
        provider.dispose();
        provider.dispose();
      }).not.toThrow();
    });
  });
});
