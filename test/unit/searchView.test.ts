import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildSearchHtml } from '../../src/vscode/searchViewProvider';

const root = resolve(__dirname, '..', '..');

describe('buildSearchHtml (Req 3.1, 3.2, 3.3)', () => {
  const nonce = 'abc123NONCE==';
  const html = buildSearchHtml('vscode-webview-resource:', nonce, 'media/search.css', 'media/search.js');

  it('contains exactly one text input', () => {
    expect(html.match(/<input\b/g)).toHaveLength(1);
    expect(html).toMatch(/<input[^>]*\btype="text"/);
  });

  it('input has the expected aria-label, placeholder and maxlength', () => {
    const input = /<input\b[^>]*>/.exec(html)![0];
    expect(input).toContain('aria-label="Search Go packages"');
    expect(input).toContain('placeholder="Search Go packages"');
    expect(input).toContain('maxlength="256"');
    expect(input).toContain('id="search"');
  });

  it('declares a CSP using the nonce for the script', () => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1];
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain(`script-src 'nonce-${nonce}'`);
    expect(csp).toContain('style-src vscode-webview-resource:');
    expect(csp).toContain('img-src data:');
    expect(html).toContain(`<script nonce="${nonce}" src="media/search.js">`);
  });
});

describe('media/search.css (Req 3.4)', () => {
  const css = readFileSync(resolve(root, 'media', 'search.css'), 'utf8');

  it.each([
    '--vscode-input-foreground',
    '--vscode-input-background',
    '--vscode-input-border',
    '--vscode-input-placeholderForeground',
    '--vscode-focusBorder',
    '--vscode-font-family',
    '--vscode-font-size',
  ])('references %s', (variable) => {
    expect(css).toContain(`var(${variable}`);
  });

  it.each(['.result-badge', '.installed-badge', '--vscode-badge-background', '--vscode-badge-foreground'])(
    'styles the Installed badge via %s',
    (token) => {
      expect(css).toContain(token);
    },
  );

  it.each(['.result-icon', '.icon-calendar', '.icon-download', 'mask-image'])(
    'styles the meta icons via %s',
    (token) => {
      expect(css).toContain(token);
    },
  );
});

describe('search webview script (Req 1.1, 1.6, 5.1, 7.2, 7.6, 8.7)', () => {
  type Handler = (event: any) => void;

  class FakeNode {
    children: FakeNode[] = [];
    attrs: Record<string, string> = {};
    handlers: Record<string, Handler> = {};
    textContent: string | null = '';
    hidden = false;
    value = '';
    constructor(readonly tag = '') {}
    addEventListener(type: string, handler: Handler): void {
      this.handlers[type] = handler;
    }
    replaceChildren(...children: FakeNode[]): void {
      this.children = children;
    }
    setAttribute(name: string, value: string): void {
      this.attrs[name] = value;
    }
    getAttribute(name: string): string | null {
      return this.attrs[name] ?? null;
    }
    closest(selector: string): FakeNode | null {
      return selector === '.result-button' && this.attrs.class === 'result-button' ? this : null;
    }
  }

  let input: FakeNode;
  let results: FakeNode;
  let status: FakeNode;
  let loading: FakeNode;
  let windowHandlers: Record<string, Handler>;
  let state: { text: string } | undefined;
  let setState: ReturnType<typeof vi.fn>;
  let postMessage: ReturnType<typeof vi.fn>;
  const g = globalThis as Record<string, unknown>;

  async function runScript(): Promise<void> {
    vi.resetModules();
    await import('../../src/webview/search.js');
  }

  beforeEach(() => {
    state = undefined;
    input = new FakeNode('input');
    results = new FakeNode('ul');
    status = new FakeNode('div');
    loading = new FakeNode('div');
    windowHandlers = {};
    setState = vi.fn((s: { text: string }) => {
      state = s;
    });
    postMessage = vi.fn();
    g.acquireVsCodeApi = () => ({ getState: () => state, setState, postMessage });
    const byId: Record<string, FakeNode> = { search: input, results, status, loading };
    g.document = {
      getElementById: (id: string) => byId[id] ?? null,
      createElement: (tag: string) => new FakeNode(tag),
      createTextNode: (text: string) => {
        const node = new FakeNode('#text');
        node.textContent = text;
        return node;
      },
    };
    g.window = {
      addEventListener: (type: string, handler: Handler) => {
        windowHandlers[type] = handler;
      },
    };
  });

  afterEach(() => {
    delete g.acquireVsCodeApi;
    delete g.document;
    delete g.window;
  });

  it('restores saved text into the input on load', async () => {
    state = { text: 'gin-gonic' };
    await runScript();
    expect(input.value).toBe('gin-gonic');
  });

  it('leaves the input empty when no state was saved', async () => {
    await runScript();
    expect(input.value).toBe('');
  });

  it('posts ready on load, and a restored text does not post a query', async () => {
    state = { text: 'gin-gonic' };
    await runScript();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
  });

  it('saves the typed text on input and posts a query', async () => {
    await runScript();
    input.value = 'cobra';
    input.handlers.input!({});
    expect(setState).toHaveBeenLastCalledWith({ text: 'cobra' });
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'query', text: 'cobra' });
  });

  it('saves and posts text clamped to 256 characters on input', async () => {
    await runScript();
    input.value = 'x'.repeat(300);
    input.handlers.input!({});
    expect(setState).toHaveBeenLastCalledWith({ text: 'x'.repeat(256) });
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'query', text: 'x'.repeat(256) });
  });

  it('calls preventDefault on Enter only and posts one submit', async () => {
    await runScript();
    postMessage.mockClear();
    input.value = 'cobra';
    const enter = { key: 'Enter', isComposing: false, preventDefault: vi.fn() };
    const other = { key: 'a', isComposing: false, preventDefault: vi.fn() };
    input.handlers.keydown!(enter);
    input.handlers.keydown!(other);
    expect(enter.preventDefault).toHaveBeenCalledTimes(1);
    expect(other.preventDefault).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'submit', text: 'cobra' });
  });

  it('ignores Enter while composing', async () => {
    await runScript();
    postMessage.mockClear();
    const enter = { key: 'Enter', isComposing: true, preventDefault: vi.fn() };
    input.handlers.keydown!(enter);
    expect(enter.preventDefault).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('renders a state message into the results, status, and loading elements', async () => {
    await runScript();
    windowHandlers.message!({
      data: {
        type: 'state',
        state: {
          results: [{ path: 'github.com/spf13/cobra', name: 'cobra' }],
          status: '1 result',
          loading: true,
          resultsVersion: 1,
        },
      },
    });
    expect(results.children).toHaveLength(1);
    expect(status.textContent).toBe('1 result');
    expect(loading.hidden).toBe(false);
  });

  const cobraState = {
    type: 'state',
    state: {
      results: [{ path: 'github.com/spf13/cobra', name: 'cobra' }],
      status: '1 result',
      loading: false,
      resultsVersion: 1,
    },
  };
  const badgeOf = (): FakeNode | undefined =>
    results.children[0]?.children[0]?.children[2]?.children.find(
      (c) => c.attrs.class === 'result-badge installed-badge',
    );

  it('shows the Installed badge when an installed message follows the state', async () => {
    await runScript();
    windowHandlers.message!({ data: cobraState });
    expect(badgeOf()).toBeUndefined();
    windowHandlers.message!({ data: { type: 'installed', modules: ['github.com/spf13/cobra'] } });
    expect(badgeOf()?.children[0]?.textContent).toBe('Installed');
    windowHandlers.message!({ data: { type: 'installed', modules: [] } });
    expect(badgeOf()).toBeUndefined();
  });

  it('applies an installed message that arrived before any state', async () => {
    await runScript();
    windowHandlers.message!({ data: { type: 'installed', modules: ['github.com/spf13/cobra'] } });
    expect(results.children).toHaveLength(0);
    windowHandlers.message!({ data: cobraState });
    expect(badgeOf()).toBeDefined();
  });

  it('ignores malformed installed messages', async () => {
    await runScript();
    windowHandlers.message!({ data: cobraState });
    windowHandlers.message!({ data: { type: 'installed', modules: ['github.com/spf13/cobra', 1] } });
    windowHandlers.message!({ data: { type: 'installed' } });
    expect(badgeOf()).toBeUndefined();
  });

  it('ignores messages that are not state messages', async () => {
    await runScript();
    windowHandlers.message!({ data: { type: 'other' } });
    windowHandlers.message!({ data: null });
    expect(results.children).toHaveLength(0);
  });

  it('posts exactly one select message with the import path of a clicked result', async () => {
    await runScript();
    postMessage.mockClear();
    const button = new FakeNode('button');
    button.attrs = { class: 'result-button', 'data-version': '3', 'data-index': '7', 'data-path': 'github.com/spf13/viper' };
    const inner = new FakeNode('span');
    inner.closest = (selector) => (selector === '.result-button' ? button : null);
    results.handlers.click!({ target: inner });
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'select', path: 'github.com/spf13/viper' });
  });

  it('posts nothing when a clicked result button has no data-path', async () => {
    await runScript();
    postMessage.mockClear();
    const button = new FakeNode('button');
    button.attrs = { class: 'result-button', 'data-version': '3', 'data-index': '7' };
    const inner = new FakeNode('span');
    inner.closest = (selector) => (selector === '.result-button' ? button : null);
    results.handlers.click!({ target: inner });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ignores clicks outside a result button', async () => {
    await runScript();
    postMessage.mockClear();
    results.handlers.click!({ target: new FakeNode('li') });
    expect(postMessage).not.toHaveBeenCalled();
  });
});
