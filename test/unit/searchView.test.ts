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
});

describe('search webview script (Req 3.3, 3.5, 3.6, 3.7)', () => {
  type Handler = (event: unknown) => void;

  interface FakeInput {
    value: string;
    handlers: Record<string, Handler>;
    addEventListener(type: string, handler: Handler): void;
  }

  let input: FakeInput;
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
    input = {
      value: '',
      handlers: {},
      addEventListener(type, handler) {
        this.handlers[type] = handler;
      },
    };
    setState = vi.fn((s: { text: string }) => {
      state = s;
    });
    postMessage = vi.fn();
    g.acquireVsCodeApi = () => ({ getState: () => state, setState, postMessage });
    g.document = {
      getElementById: (id: string) => (id === 'search' ? input : null),
    };
  });

  afterEach(() => {
    delete g.acquireVsCodeApi;
    delete g.document;
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

  it('saves the typed text on input', async () => {
    await runScript();
    input.value = 'cobra';
    input.handlers.input!({});
    expect(setState).toHaveBeenLastCalledWith({ text: 'cobra' });
  });

  it('saves text clamped to 256 characters on input', async () => {
    await runScript();
    input.value = 'x'.repeat(300);
    input.handlers.input!({});
    expect(setState).toHaveBeenLastCalledWith({ text: 'x'.repeat(256) });
  });

  it('calls preventDefault on Enter only', async () => {
    await runScript();
    const enter = { key: 'Enter', preventDefault: vi.fn() };
    const other = { key: 'a', preventDefault: vi.fn() };
    input.handlers.keydown!(enter);
    input.handlers.keydown!(other);
    expect(enter.preventDefault).toHaveBeenCalledTimes(1);
    expect(other.preventDefault).not.toHaveBeenCalled();
  });

  it('never calls postMessage', async () => {
    await runScript();
    input.value = 'abc';
    input.handlers.input!({});
    input.handlers.keydown!({ key: 'Enter', preventDefault: vi.fn() });
    expect(postMessage).not.toHaveBeenCalled();
  });
});
