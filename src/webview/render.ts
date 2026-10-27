import { toResultEntry, type ResultEntry } from '../core/resultView';
import type { SearchViewModel } from '../core/searchProtocol';

/** The part of a DOM node that `renderState` reads or writes. Real DOM nodes satisfy it. */
export interface NodeLike {
  textContent: string | null;
  hidden?: boolean;
}

/**
 * The small DOM surface used for rendering, so tests can supply a fake DOM.
 * Values are only ever placed into text nodes; there is no way to inject markup.
 */
export interface DomLike<N extends NodeLike = NodeLike> {
  createElement(tag: string): N;
  createTextNode(text: string): N;
  replaceChildren(parent: N, children: readonly N[]): void;
  setAttribute(node: N, name: string, value: string): void;
}

export interface RenderElements<N extends NodeLike = NodeLike> {
  /** The `<ul>` Result_List. */
  readonly results: N;
  /** The Status_Message live region. */
  readonly status: N;
  /** The Loading_Indicator. */
  readonly loading: N;
}

/** Last `resultsVersion` rendered into each Result_List element. */
const renderedVersions = new WeakMap<object, number>();

function textSpan<N extends NodeLike>(dom: DomLike<N>, className: string, ...texts: string[]): N {
  const span = dom.createElement('span');
  dom.setAttribute(span, 'class', className);
  dom.replaceChildren(
    span,
    texts.map((text) => dom.createTextNode(text)),
  );
  return span;
}

function buildDescription<N extends NodeLike>(dom: DomLike<N>, entry: ResultEntry, id: string): N {
  const desc = dom.createElement('span');
  dom.setAttribute(desc, 'id', id);
  dom.setAttribute(desc, 'class', 'result-desc');
  const children: N[] = [];

  if (entry.synopsis !== undefined) {
    children.push(textSpan(dom, 'result-synopsis', entry.synopsis));
  }

  const meta: N[] = [];
  if (entry.version !== undefined) {
    meta.push(textSpan(dom, 'result-version', entry.version));
  }
  if (entry.published !== undefined) {
    meta.push(textSpan(dom, 'result-published', 'published ', entry.published));
  }
  if (entry.importedBy !== undefined) {
    meta.push(textSpan(dom, 'result-imported', 'Imported by ', entry.importedBy));
  }
  if (meta.length > 0) {
    const metaSpan = dom.createElement('span');
    dom.setAttribute(metaSpan, 'class', 'result-meta');
    dom.replaceChildren(metaSpan, meta);
    children.push(metaSpan);
  }

  dom.replaceChildren(desc, children);
  return desc;
}

function buildResult<N extends NodeLike>(
  dom: DomLike<N>,
  entry: ResultEntry,
  version: number,
  index: number,
): N {
  const item = dom.createElement('li');
  dom.setAttribute(item, 'class', 'result');

  const descId = `r${version}-${index}-desc`;
  const button = dom.createElement('button');
  dom.setAttribute(button, 'type', 'button');
  dom.setAttribute(button, 'class', 'result-button');
  dom.setAttribute(button, 'aria-label', entry.path);
  dom.setAttribute(button, 'aria-describedby', descId);
  dom.setAttribute(button, 'data-version', String(version));
  dom.setAttribute(button, 'data-index', String(index));
  dom.replaceChildren(button, [
    textSpan(dom, 'result-path', entry.path),
    textSpan(dom, 'result-name', entry.name),
    buildDescription(dom, entry, descId),
  ]);

  dom.replaceChildren(item, [button]);
  return item;
}

/**
 * Renders the host's view state. The Result_List is rebuilt only when
 * `resultsVersion` changes, so status and loading updates never move focus.
 * The Status_Message text is assigned only when it differs, so the live
 * region announces each change once.
 */
export function renderState<N extends NodeLike>(
  dom: DomLike<N>,
  elements: RenderElements<N>,
  state: SearchViewModel,
): void {
  if (renderedVersions.get(elements.results) !== state.resultsVersion) {
    const version = state.resultsVersion;
    dom.replaceChildren(
      elements.results,
      state.results.map((result, index) => buildResult(dom, toResultEntry(result), version, index)),
    );
    renderedVersions.set(elements.results, version);
  }

  if (elements.status.textContent !== state.status) {
    elements.status.textContent = state.status;
  }

  elements.loading.hidden = !state.loading;
}
