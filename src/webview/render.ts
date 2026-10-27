import { isInstalledPackage } from '../core/installedMatch';
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

/** Last `resultsVersion` and installed result indexes (comma-joined) rendered into each Result_List element. */
const renderedVersions = new WeakMap<object, { version: number; flags: string }>();

const NO_INSTALLED: ReadonlySet<string> = new Set();

function textSpan<N extends NodeLike>(dom: DomLike<N>, className: string, ...texts: string[]): N {
  const span = dom.createElement('span');
  dom.setAttribute(span, 'class', className);
  dom.replaceChildren(
    span,
    texts.map((text) => dom.createTextNode(text)),
  );
  return span;
}

function iconSpan<N extends NodeLike>(dom: DomLike<N>, iconClass: string, tooltip: string): N {
  const icon = dom.createElement('span');
  dom.setAttribute(icon, 'class', `result-icon ${iconClass}`);
  dom.setAttribute(icon, 'title', tooltip);
  dom.setAttribute(icon, 'role', 'img');
  dom.setAttribute(icon, 'aria-label', tooltip);
  return icon;
}

function iconValueSpan<N extends NodeLike>(
  dom: DomLike<N>,
  className: string,
  iconClass: string,
  tooltip: string,
  value: string,
): N {
  const span = dom.createElement('span');
  dom.setAttribute(span, 'class', className);
  dom.replaceChildren(span, [iconSpan(dom, iconClass, tooltip), dom.createTextNode(value)]);
  return span;
}

function buildDescription<N extends NodeLike>(
  dom: DomLike<N>,
  entry: ResultEntry,
  id: string,
  installed: boolean,
): N {
  const desc = dom.createElement('span');
  dom.setAttribute(desc, 'id', id);
  dom.setAttribute(desc, 'class', 'result-desc');
  const children: N[] = [];

  if (installed) {
    children.push(textSpan(dom, 'result-badge installed-badge', 'Installed'));
  }

  if (entry.synopsis !== undefined) {
    children.push(textSpan(dom, 'result-synopsis', entry.synopsis));
  }

  const meta: N[] = [];
  if (entry.version !== undefined) {
    meta.push(textSpan(dom, 'result-version', entry.version));
  }
  if (entry.published !== undefined) {
    meta.push(iconValueSpan(dom, 'result-published', 'icon-calendar', 'Publish date', entry.published));
  }
  if (entry.importedBy !== undefined) {
    meta.push(iconValueSpan(dom, 'result-imported', 'icon-download', 'Number of import', entry.importedBy));
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
  installed: boolean,
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
  dom.setAttribute(button, 'data-path', entry.path);
  dom.replaceChildren(button, [
    textSpan(dom, 'result-path', entry.path),
    textSpan(dom, 'result-name', entry.name),
    buildDescription(dom, entry, descId, installed),
  ]);

  dom.replaceChildren(item, [button]);
  return item;
}

/**
 * Renders the host's view state. The Result_List is rebuilt only when
 * `resultsVersion` or the per-result installed flags change, so status and
 * loading updates never move focus. The Status_Message text is assigned only
 * when it differs, so the live region announces each change once.
 */
export function renderState<N extends NodeLike>(
  dom: DomLike<N>,
  elements: RenderElements<N>,
  state: SearchViewModel,
  installed: ReadonlySet<string> = NO_INSTALLED,
): void {
  const installedIndexes = new Set<number>();
  state.results.forEach((result, index) => {
    if (isInstalledPackage(result.path, installed)) {
      installedIndexes.add(index);
    }
  });
  const flags = [...installedIndexes].join(',');
  const rendered = renderedVersions.get(elements.results);
  if (rendered?.version !== state.resultsVersion || rendered.flags !== flags) {
    const version = state.resultsVersion;
    dom.replaceChildren(
      elements.results,
      state.results.map((result, index) =>
        buildResult(dom, toResultEntry(result), version, index, installedIndexes.has(index)),
      ),
    );
    renderedVersions.set(elements.results, { version, flags });
  }

  if (elements.status.textContent !== state.status) {
    elements.status.textContent = state.status;
  }

  elements.loading.hidden = !state.loading;
}
