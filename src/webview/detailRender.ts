import type { DetailViewModel } from '../core/detailProtocol';
import { detailLoading } from '../core/messages';
import type { Link, PackageDetail } from '../core/packageDetail';
import type { DomLike, NodeLike } from './render';

export type BuildContext = NonNullable<PackageDetail['buildContext']>;

/** Id of the Install/Uninstall button in the header. */
export const ACTION_ID = 'detail-action';
/** Id of the GOOS dropdown. */
export const GOOS_SELECT_ID = 'detail-goos';
/** Class of every Retry button; the view delegates clicks on it. */
export const RETRY_CLASS = 'detail-retry';
/** Class of every link whose click is handled by the view. */
export const LINK_CLASS = 'detail-link';

export const IDLE_TEXT = 'Select a package from the Search view.';
export const CHECK_YES = '\u2713';
export const CHECK_NO = '\u2717';

function element<N extends NodeLike>(
  dom: DomLike<N>,
  tag: string,
  className: string | undefined,
  children: readonly N[] = [],
): N {
  const node = dom.createElement(tag);
  if (className !== undefined) {
    dom.setAttribute(node, 'class', className);
  }
  if (children.length > 0) {
    dom.replaceChildren(node, children);
  }
  return node;
}

function textElement<N extends NodeLike>(dom: DomLike<N>, tag: string, className: string | undefined, text: string): N {
  return element(dom, tag, className, [dom.createTextNode(text)]);
}

function linkElement<N extends NodeLike>(dom: DomLike<N>, link: Link): N {
  const anchor = textElement(dom, 'a', LINK_CLASS, link.text);
  dom.setAttribute(anchor, 'href', link.url);
  return anchor;
}

function metaItem<N extends NodeLike>(dom: DomLike<N>, label: string, values: readonly N[]): N {
  const children: N[] = [textElement(dom, 'span', 'detail-meta-label', label)];
  values.forEach((value, index) => {
    if (index > 0) {
      children.push(dom.createTextNode(', '));
    }
    children.push(value);
  });
  return element(dom, 'li', 'detail-meta-item', children);
}

function buildMeta<N extends NodeLike>(dom: DomLike<N>, detail: PackageDetail): N {
  const items: N[] = [];
  if (detail.version !== undefined) {
    items.push(metaItem(dom, 'Version', [linkElement(dom, detail.version)]));
  }
  if (detail.published !== undefined) {
    items.push(metaItem(dom, 'Published', [dom.createTextNode(detail.published)]));
  }
  if (detail.licenses.length > 0) {
    items.push(metaItem(dom, 'License', detail.licenses.map((license) => linkElement(dom, license))));
  }
  if (detail.imports !== undefined) {
    items.push(metaItem(dom, 'Imports', [linkElement(dom, detail.imports)]));
  }
  if (detail.importedBy !== undefined) {
    items.push(metaItem(dom, 'Imported by', [linkElement(dom, detail.importedBy)]));
  }
  return element(dom, 'ul', 'detail-meta', items);
}

function buildChecks<N extends NodeLike>(dom: DomLike<N>, detail: PackageDetail): N {
  const items = detail.checks.map((check) => {
    const marker = textElement(dom, 'span', 'detail-check-marker', check.ok ? CHECK_YES : CHECK_NO);
    dom.setAttribute(marker, 'aria-hidden', 'true');
    const label = dom.createTextNode(check.label);
    const state = textElement(dom, 'span', 'visually-hidden', check.ok ? ': Yes' : ': No');
    return element(dom, 'li', check.ok ? 'detail-check is-ok' : 'detail-check is-not-ok', [marker, label, state]);
  });
  const list = element(dom, 'ul', 'detail-checks', items);
  dom.setAttribute(list, 'aria-label', 'Package checks');
  return list;
}

function buildLinks<N extends NodeLike>(dom: DomLike<N>, detail: PackageDetail): N {
  const links: Link[] = [];
  if (detail.repository !== undefined) {
    links.push({ text: `Repository: ${detail.repository.text}`, url: detail.repository.url });
  }
  links.push(...detail.links);
  links.push({ text: 'View on pkg.go.dev', url: detail.pageUrl });
  return element(
    dom,
    'ul',
    'detail-links',
    links.map((link) => element(dom, 'li', 'detail-links-item', [linkElement(dom, link)])),
  );
}

/** Sets the Install/Uninstall label on the action button. */
export function setInstalledButton<N extends NodeLike>(dom: DomLike<N>, button: N, installed: boolean): void {
  dom.replaceChildren(button, [dom.createTextNode(installed ? 'Uninstall' : 'Install')]);
}

/**
 * Builds the header section: title, chips, properties, checks, links and the
 * single Install/Uninstall button, which is returned. Every value goes in through text nodes.
 */
export function renderHeader<N extends NodeLike>(
  dom: DomLike<N>,
  headerEl: N,
  detail: PackageDetail,
  installed: boolean,
): N {
  const chips = detail.chips.map((chip) => textElement(dom, 'span', 'detail-chip', chip));
  const button = dom.createElement('button');
  dom.setAttribute(button, 'type', 'button');
  dom.setAttribute(button, 'id', ACTION_ID);
  dom.setAttribute(button, 'class', 'detail-action');
  setInstalledButton(dom, button, installed);

  const titleRow = element(dom, 'div', 'detail-title-row', [
    textElement(dom, 'h1', 'detail-title', detail.title),
    element(dom, 'span', 'detail-chips', chips),
    button,
  ]);

  const children: N[] = [titleRow, textElement(dom, 'div', 'detail-import-path', detail.importPath), buildMeta(dom, detail)];
  if (detail.checks.length > 0) {
    children.push(buildChecks(dom, detail));
  }
  children.push(buildLinks(dom, detail));
  dom.replaceChildren(headerEl, children);
  return button;
}

/**
 * Builds the "Rendered for" GOOS dropdown into `container`. Leaves the
 * container empty when the page offers no build contexts.
 */
export function renderGoosSelect<N extends NodeLike>(
  dom: DomLike<N>,
  container: N,
  buildContext: BuildContext | undefined,
  current: string,
  disabled: boolean,
): void {
  if (buildContext === undefined || buildContext.options.length === 0) {
    dom.replaceChildren(container, []);
    return;
  }
  const label = textElement(dom, 'label', 'detail-goos-label', 'Rendered for');
  dom.setAttribute(label, 'for', GOOS_SELECT_ID);

  const select = dom.createElement('select');
  dom.setAttribute(select, 'id', GOOS_SELECT_ID);
  dom.setAttribute(select, 'class', 'detail-goos');
  if (disabled) {
    dom.setAttribute(select, 'disabled', '');
  }
  const options = buildContext.options.map((option) => {
    const node = textElement(dom, 'option', undefined, option.label);
    dom.setAttribute(node, 'value', option.value);
    if (option.value === current) {
      dom.setAttribute(node, 'selected', '');
    }
    return node;
  });
  dom.replaceChildren(select, options);
  dom.replaceChildren(container, [label, select]);
}

/** Fills `container` with a message and a Retry button, or empties it when `message` is undefined. */
export function renderRetry<N extends NodeLike>(dom: DomLike<N>, container: N, message: string | undefined): void {
  if (message === undefined) {
    dom.replaceChildren(container, []);
    container.hidden = true;
    return;
  }
  const retry = textElement(dom, 'button', RETRY_CLASS, 'Retry');
  dom.setAttribute(retry, 'type', 'button');
  dom.replaceChildren(container, [textElement(dom, 'span', 'detail-error-text', message), retry]);
  container.hidden = false;
}

/** Renders the idle, loading and page-error states into the status and error regions. */
export function renderStatus<N extends NodeLike>(
  dom: DomLike<N>,
  statusEl: N,
  errorEl: N,
  model: Pick<DetailViewModel, 'status' | 'path' | 'error'>,
): void {
  if (model.status === 'idle') {
    dom.replaceChildren(statusEl, [dom.createTextNode(IDLE_TEXT)]);
  } else if (model.status === 'loading') {
    const bar = element(dom, 'div', 'detail-loading', [element(dom, 'div', 'detail-loading-bar')]);
    dom.setAttribute(bar, 'aria-hidden', 'true');
    dom.replaceChildren(statusEl, [dom.createTextNode(detailLoading(model.path)), bar]);
  } else {
    dom.replaceChildren(statusEl, []);
  }
  renderRetry(dom, errorEl, model.status === 'error' ? (model.error ?? '') : undefined);
}
