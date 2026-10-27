import type { DetailToHost, DetailViewModel, HostToDetail } from '../core/detailProtocol';
import type { PackageDetail } from '../core/packageDetail';
import {
  ACTION_ID,
  GOOS_SELECT_ID,
  RETRY_CLASS,
  renderActionError,
  renderGoosSelect,
  renderHeader,
  renderRetry,
  renderStatus,
  setInstalledButton,
} from './detailRender';
import type { DomLike, NodeLike } from './render';

interface DetailWebviewApi {
  postMessage(message: DetailToHost): void;
}

declare function acquireVsCodeApi(): DetailWebviewApi;

type DomNode = Node & NodeLike;

/** README taller than this (px) starts collapsed with an Expand button. */
export const README_COLLAPSE_HEIGHT = 480;

const STATUSES: ReadonlySet<string> = new Set(['idle', 'loading', 'ready', 'error']);

function asNode(element: Element): DomNode {
  return element as unknown as DomNode;
}

function isDetail(value: unknown): value is PackageDetail {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.title === 'string' &&
    typeof record.pageUrl === 'string' &&
    typeof record.importPath === 'string' &&
    Array.isArray(record.chips) &&
    Array.isArray(record.licenses) &&
    Array.isArray(record.checks) &&
    Array.isArray(record.links)
  );
}

function isStateMessage(data: unknown): data is Extract<HostToDetail, { type: 'state' }> {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  const state = record.state as Partial<DetailViewModel> | null | undefined;
  if (
    record.type !== 'state' ||
    typeof state !== 'object' ||
    state === null ||
    typeof state.status !== 'string' ||
    !STATUSES.has(state.status) ||
    typeof state.path !== 'string' ||
    typeof state.installed !== 'boolean' ||
    typeof state.mainLoading !== 'boolean'
  ) {
    return false;
  }
  return state.status !== 'ready' || isDetail(state.detail);
}

function isInstalledMessage(data: unknown): data is Extract<HostToDetail, { type: 'installed' }> {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return record.type === 'installed' && typeof record.installed === 'boolean';
}

function isActionMessage(data: unknown): data is Extract<HostToDetail, { type: 'action' }> {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const record = data as Record<string, unknown>;
  return (
    record.type === 'action' &&
    typeof record.installed === 'boolean' &&
    (record.busy === undefined || record.busy === 'install' || record.busy === 'uninstall') &&
    (record.error === undefined || typeof record.error === 'string')
  );
}

interface MainRefs {
  readonly banner: HTMLElement;
  readonly loading: HTMLElement;
  readonly error: HTMLElement;
  readonly gooSlot: HTMLElement | undefined;
}

/**
 * Package detail view. It posts `ready` on start, renders the host's view state
 * with DOM APIs, and puts host-sanitized HTML only into the README and
 * Documentation containers. Exported so tests can drive it with a fake DOM.
 */
export function startDetailView(doc: Document, win: Window, api: DetailWebviewApi): void {
  const root = doc.getElementById('detail-root');
  const statusEl = doc.getElementById('detail-status');
  const errorEl = doc.getElementById('detail-error');
  const headerEl = doc.getElementById('detail-header');
  const actionErrorEl = doc.getElementById('detail-action-error');
  const mainEl = doc.getElementById('detail-main');
  if (!root || !statusEl || !errorEl || !headerEl || !actionErrorEl || !mainEl) {
    return;
  }

  const dom: DomLike<DomNode> = {
    createElement: (tag) => doc.createElement(tag) as unknown as DomNode,
    createTextNode: (text) => doc.createTextNode(text) as unknown as DomNode,
    replaceChildren: (parent, children) => (parent as unknown as Element).replaceChildren(...children),
    setAttribute: (node, name, value) => (node as unknown as Element).setAttribute(name, value),
  };

  let installed = false;
  let busy: 'install' | 'uninstall' | undefined;
  let renderedDetail: PackageDetail | undefined;
  let actionButton: HTMLElement | undefined;
  let mainRefs: MainRefs | undefined;
  let pendingGoos: string | undefined;
  let lastGoosKey: string | undefined;

  const el = (tag: string, className: string): HTMLElement => {
    const node = doc.createElement(tag);
    node.setAttribute('class', className);
    return node;
  };
  const textEl = (tag: string, className: string, text: string): HTMLElement => {
    const node = el(tag, className);
    node.appendChild(doc.createTextNode(text));
    return node;
  };

  function clearContent(): void {
    renderActionError(dom, asNode(actionErrorEl!), undefined);
    renderedDetail = undefined;
    actionButton = undefined;
    mainRefs = undefined;
    lastGoosKey = undefined;
    pendingGoos = undefined;
    headerEl!.replaceChildren();
    mainEl!.replaceChildren();
    mainEl!.removeAttribute('aria-busy');
    mainEl!.setAttribute('class', 'detail-main');
  }

  function buildReadme(detail: PackageDetail): { section: HTMLElement; collapseIfTall: () => void } | undefined {
    if (detail.readmeHtml === undefined) {
      return undefined;
    }
    const section = el('section', 'detail-section detail-readme');
    const toggle = textEl('button', 'detail-toggle', 'Expand');
    toggle.setAttribute('type', 'button');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.hidden = true;
    const head = el('div', 'detail-section-head');
    head.append(textEl('h2', 'detail-section-title', 'README'), toggle);

    const content = el('div', 'detail-content detail-readme-content');
    // The HTML is host-sanitized by an allowlist sanitizer (plan section 6) and the CSP forbids inline script.
    content.innerHTML = detail.readmeHtml;
    section.append(head, content);

    toggle.addEventListener('click', () => {
      const collapsed = content.classList.toggle('is-collapsed');
      toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      toggle.textContent = collapsed ? 'Expand' : 'Collapse';
    });
    // scrollHeight is 0 for a detached element, so this runs after the section is in the document.
    const collapseIfTall = (): void => {
      if (content.scrollHeight > README_COLLAPSE_HEIGHT) {
        content.classList.add('is-collapsed');
        toggle.hidden = false;
      }
    };
    return { section, collapseIfTall };
  }

  function buildDocumentation(detail: PackageDetail): { section: HTMLElement | undefined; gooSlot: HTMLElement | undefined } {
    if (detail.docHtml === undefined && detail.buildContext === undefined) {
      return { section: undefined, gooSlot: undefined };
    }
    const section = el('section', 'detail-section detail-documentation');
    const head = el('div', 'detail-section-head');
    head.append(textEl('h2', 'detail-section-title', 'Documentation'));
    const gooSlot = el('div', 'detail-goos-slot');
    head.append(gooSlot);
    section.append(head);
    if (detail.docHtml !== undefined) {
      const content = el('div', 'detail-content detail-doc-content');
      // The HTML is host-sanitized by an allowlist sanitizer (plan section 6) and the CSP forbids inline script.
      content.innerHTML = detail.docHtml;
      section.append(content);
    }
    return { section, gooSlot };
  }

  function buildMain(detail: PackageDetail): void {
    const loading = el('div', 'detail-loading');
    loading.setAttribute('aria-hidden', 'true');
    loading.append(el('div', 'detail-loading-bar'));
    loading.hidden = true;
    const error = el('div', 'detail-error detail-main-error');
    error.setAttribute('role', 'alert');
    error.hidden = true;
    const banner = el('div', 'detail-main-banner');
    banner.append(loading, error);

    const readme = buildReadme(detail);
    const docs = buildDocumentation(detail);
    const children: HTMLElement[] = [banner];
    if (readme) {
      children.push(readme.section);
    }
    if (docs.section) {
      children.push(docs.section);
    }
    if (!readme && !docs.section) {
      children.push(textEl('p', 'detail-empty', 'No documentation is available for this package.'));
    }
    mainEl!.replaceChildren(...children);
    readme?.collapseIfTall();
    mainRefs = { banner, loading, error, gooSlot: docs.gooSlot };
    lastGoosKey = undefined;
  }

  function updateMainState(model: DetailViewModel, detail: PackageDetail): void {
    if (!mainRefs) {
      return;
    }
    mainEl!.setAttribute('class', model.mainLoading ? 'detail-main is-loading' : 'detail-main');
    if (model.mainLoading) {
      mainEl!.setAttribute('aria-busy', 'true');
    } else {
      mainEl!.removeAttribute('aria-busy');
      pendingGoos = undefined;
    }
    mainRefs.loading.hidden = !model.mainLoading;
    renderRetry(dom, asNode(mainRefs.error), model.error);

    if (mainRefs.gooSlot) {
      const current = model.mainLoading && pendingGoos !== undefined ? pendingGoos : (model.goos ?? detail.buildContext?.selected ?? '');
      const key = `${current}|${model.mainLoading}`;
      if (key !== lastGoosKey) {
        lastGoosKey = key;
        renderGoosSelect(dom, asNode(mainRefs.gooSlot), detail.buildContext, current, model.mainLoading);
      }
    }
  }

  function render(model: DetailViewModel): void {
    installed = model.installed;
    busy = model.busy;
    if (model.status !== 'ready' || model.detail === undefined) {
      clearContent();
      renderStatus(dom, asNode(statusEl!), asNode(errorEl!), model);
      return;
    }
    renderStatus(dom, asNode(statusEl!), asNode(errorEl!), model);
    const detail = model.detail;
    if (renderedDetail !== detail) {
      renderedDetail = detail;
      actionButton = renderHeader(dom, asNode(headerEl!), detail, installed, busy) as unknown as HTMLElement;
      buildMain(detail);
    } else if (actionButton) {
      setInstalledButton(dom, asNode(actionButton), installed, busy);
    }
    renderActionError(dom, asNode(actionErrorEl!), model.actionError);
    updateMainState(model, detail);
  }

  win.addEventListener('message', (event: MessageEvent) => {
    const data: unknown = event.data;
    if (isStateMessage(data)) {
      render(data.state);
    } else if (isInstalledMessage(data)) {
      installed = data.installed;
      if (actionButton) {
        setInstalledButton(dom, asNode(actionButton), installed, busy);
      }
    } else if (isActionMessage(data)) {
      installed = data.installed;
      busy = data.busy;
      if (actionButton) {
        setInstalledButton(dom, asNode(actionButton), installed, busy);
      }
      renderActionError(dom, asNode(actionErrorEl!), data.error);
    }
  });

  root.addEventListener('click', (event: Event) => {
    const target = event.target as Element | null;
    if (!target?.closest) {
      return;
    }
    const anchor = target.closest('a');
    if (anchor) {
      event.preventDefault();
      const href = anchor.getAttribute('href');
      if (href === null || href === '') {
        return;
      }
      if (href.startsWith('#')) {
        scrollToFragment(href.slice(1));
      } else {
        api.postMessage({ type: 'openLink', url: href });
      }
      return;
    }
    if (target.closest(`.${RETRY_CLASS}`)) {
      api.postMessage({ type: 'retry' });
      return;
    }
    if (target.closest(`#${ACTION_ID}`)) {
      if (busy !== undefined) {
        return;
      }
      api.postMessage({ type: installed ? 'uninstall' : 'install' });
    }
  });

  root.addEventListener('change', (event: Event) => {
    const target = event.target as (Element & { value?: string }) | null;
    if (!target?.closest?.(`#${GOOS_SELECT_ID}`) || typeof target.value !== 'string') {
      return;
    }
    pendingGoos = target.value;
    api.postMessage({ type: 'changeGoos', goos: target.value });
  });

  function scrollToFragment(fragment: string): void {
    try {
      const id = decodeURIComponent(fragment);
      if (id !== '') {
        doc.getElementById(id)?.scrollIntoView({ block: 'start' });
      }
    } catch {
      // Malformed percent-escape: ignore the click.
    }
  }

  renderStatus(dom, asNode(statusEl), asNode(errorEl), { status: 'idle', path: '', error: undefined });
  api.postMessage({ type: 'ready' });
}

if (typeof acquireVsCodeApi === 'function') {
  startDetailView(document, window, acquireVsCodeApi());
}
