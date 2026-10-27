import type { HostToWebview, SearchViewModel, WebviewToHost } from '../core/searchProtocol';
import { clampSearchText } from '../core/searchText';
import { renderState, type DomLike, type NodeLike, type RenderElements } from './render';

interface SearchViewState {
  text: string;
}

interface WebviewApi {
  getState(): SearchViewState | undefined;
  setState(state: SearchViewState): void;
  postMessage(message: WebviewToHost): void;
}

declare function acquireVsCodeApi(): WebviewApi;

type DomNode = Node & NodeLike;

/** Adapts the real `document` to the small surface used by `renderState`. */
const realDom: DomLike<DomNode> = {
  createElement: (tag) => document.createElement(tag) as unknown as DomNode,
  createTextNode: (text) => document.createTextNode(text) as unknown as DomNode,
  replaceChildren: (parent, children) => (parent as unknown as Element).replaceChildren(...children),
  setAttribute: (node, name, value) => (node as unknown as Element).setAttribute(name, value),
};

function isStateMessage(data: unknown): data is Extract<HostToWebview, { type: 'state' }> {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  const state = record.state as Partial<SearchViewModel> | null | undefined;
  return (
    record.type === 'state' &&
    typeof state === 'object' &&
    state !== null &&
    Array.isArray(state.results) &&
    typeof state.status === 'string' &&
    typeof state.loading === 'boolean' &&
    typeof state.resultsVersion === 'number'
  );
}

function isInstalledMessage(data: unknown): data is Extract<HostToWebview, { type: 'installed' }> {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    record.type === 'installed' &&
    Array.isArray(record.modules) &&
    record.modules.every((module) => typeof module === 'string')
  );
}

function parseIndex(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value)) {
    return undefined;
  }
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : undefined;
}

// Search_Box script. It persists the text through the webview state API, tells
// the host about typing (`query`), Enter (`submit`), and result clicks (`open`),
// and renders the host's view state. It never builds markup from strings.
(function main(): void {
  const vscode = acquireVsCodeApi();
  const input = document.getElementById('search') as HTMLInputElement | null;
  if (!input) {
    return;
  }

  const saved = vscode.getState();
  input.value = saved?.text ?? '';

  input.addEventListener('input', () => {
    const text = clampSearchText(input.value);
    vscode.setState({ text });
    vscode.postMessage({ type: 'query', text });
  });

  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing) {
      event.preventDefault();
      vscode.postMessage({ type: 'submit', text: clampSearchText(input.value) });
    }
  });

  const results = document.getElementById('results');
  const status = document.getElementById('status');
  const loading = document.getElementById('loading');

  if (results && status && loading) {
    const elements: RenderElements<DomNode> = {
      results: results as unknown as DomNode,
      status: status as unknown as DomNode,
      loading: loading as unknown as DomNode,
    };

    let lastState: SearchViewModel | undefined;
    let installed: ReadonlySet<string> = new Set();

    window.addEventListener('message', (event: MessageEvent) => {
      if (isStateMessage(event.data)) {
        lastState = event.data.state;
        renderState(realDom, elements, lastState, installed);
      } else if (isInstalledMessage(event.data)) {
        installed = new Set(event.data.modules);
        if (lastState === undefined) {
          return;
        }
        // A rebuild drops focus from the focused result, so restore it by index.
        const active = document.activeElement as Element | null | undefined;
        const focusedIndex = parseIndex(active?.closest?.('.result-button')?.getAttribute('data-index') ?? null);
        renderState(realDom, elements, lastState, installed);
        if (focusedIndex !== undefined) {
          const button = results.querySelector?.(`.result-button[data-index="${focusedIndex}"]`);
          (button as HTMLElement | null | undefined)?.focus?.();
        }
      }
    });

    results.addEventListener('click', (event: Event) => {
      const target = event.target as Element | null;
      const button = target?.closest?.('.result-button');
      if (!button) {
        return;
      }
      const resultsVersion = parseIndex(button.getAttribute('data-version'));
      const index = parseIndex(button.getAttribute('data-index'));
      if (resultsVersion === undefined || index === undefined) {
        return;
      }
      vscode.postMessage({ type: 'open', resultsVersion, index });
    });
  }

  // A restored text does not start a search; `ready` only asks for the current state.
  vscode.postMessage({ type: 'ready' });
})();
