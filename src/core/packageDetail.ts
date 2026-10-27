import { sanitizeNodes, resolveLink } from './htmlSanitize';
import {
  attr,
  findAll,
  findFirst,
  hasClass,
  parseHtmlTree,
  textContent,
  type HtmlElement,
} from './htmlTree';
import { PKG_GO_DEV_HOST } from './searchQuery';

export interface Link {
  readonly text: string;
  readonly url: string;
}

export interface BuildContextOption {
  readonly value: string;
  readonly label: string;
}

export interface PackageCheck {
  readonly label: string;
  readonly ok: boolean;
}

export interface PackageDetail {
  /** Requested import path. */
  readonly path: string;
  /** `https://pkg.go.dev/<path>`. */
  readonly pageUrl: string;
  readonly title: string;
  /** Canonical import path from the breadcrumb, clipboard button or the requested path. */
  readonly importPath: string;
  readonly chips: readonly string[];
  readonly version?: Link;
  readonly published?: string;
  readonly licenses: readonly Link[];
  readonly imports?: Link;
  readonly importedBy?: Link;
  readonly checks: readonly PackageCheck[];
  readonly repository?: Link;
  readonly links: readonly Link[];
  /** Sanitized HTML. */
  readonly readmeHtml?: string;
  /** Sanitized HTML. */
  readonly docHtml?: string;
  readonly buildContext?: {
    readonly selected: string;
    readonly options: readonly BuildContextOption[];
  };
}

/** Every pkg.go.dev markup hook the parser relies on, taken from `sample-pages/package_detail.html` and the live site. */
const SELECTORS = {
  header: { tag: 'header', className: 'go-Main-header' },
  aside: { tag: 'aside', className: 'go-Main-aside' },
  article: { tag: 'article', className: 'go-Main-article' },
  title: { tag: 'h1', attr: 'data-test-id', value: 'UnitHeader-title' },
  headerTitle: { className: 'go-Main-headerTitle' },
  chip: { tag: 'span', className: 'go-Chip' },
  breadcrumbCurrent: { tag: 'a', attr: 'data-test-id', value: 'UnitHeader-breadcrumbCurrent' },
  clipboard: { tag: 'button', className: 'js-clipboard', copyAttr: 'data-to-copy' },
  version: { attr: 'data-test-id', value: 'UnitHeader-version' },
  commitTime: { attr: 'data-test-id', value: 'UnitHeader-commitTime' },
  license: { tag: 'a', attr: 'data-test-id', value: 'UnitHeader-license' },
  imports: { attr: 'data-test-id', value: 'UnitHeader-imports' },
  importedBy: { attr: 'data-test-id', value: 'UnitHeader-importedby' },
  subtle: { className: 'go-textSubtle' },
  checkList: { tag: 'ul', className: 'UnitMeta-details' },
  checkItem: { tag: 'li' },
  checkSummary: { tag: 'summary', details: 'details' },
  checkImage: { tag: 'img', checkedAlt: 'checked' },
  repository: { className: 'UnitMeta-repo', tag: 'a' },
  links: { tag: 'ul', className: 'UnitMeta-links', link: 'a' },
  readme: { className: 'Overview-readmeContent' },
  doc: { className: 'Documentation-content' },
  buildSelect: { tag: 'select', className: 'js-buildContextSelect', option: 'option', selectedAttr: 'selected' },
} as const;

const PUBLISHED_PREFIX = /^published:\s*/iu;
const COUNT_PREFIX = /^[^:]*:\s*/u;
const VERSION_PREFIX = /^version:\s*/iu;

function byTag(tag: string, className?: string): (el: HtmlElement) => boolean {
  return (el) => el.name === tag && (className === undefined || hasClass(el, className));
}

function byClass(className: string): (el: HtmlElement) => boolean {
  return (el) => hasClass(el, className);
}

function byAttr(name: string, value: string, tag?: string): (el: HtmlElement) => boolean {
  return (el) => (tag === undefined || el.name === tag) && attr(el, name) === value;
}

/** Text of `el` without the leading subtle label (`Version: `, `Imports: `) inside it. */
function textWithoutLabel(el: HtmlElement): string {
  const full = textContent(el);
  const label = findFirst(el, byClass(SELECTORS.subtle.className));
  if (label === undefined) {
    return full;
  }
  const labelText = textContent(label);
  return labelText !== '' && full.startsWith(labelText) ? full.slice(labelText.length).trim() : full;
}

function absoluteUrl(raw: string | undefined, pageUrl: string): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const link = resolveLink(raw, pageUrl);
  if (link === undefined) {
    return undefined;
  }
  return link.kind === 'external' ? link.url : `${pageUrl}#${encodeURIComponent(link.id)}`;
}

function toLink(text: string, raw: string | undefined, pageUrl: string): Link | undefined {
  const url = absoluteUrl(raw, pageUrl);
  if (url === undefined) {
    return undefined;
  }
  return { text: text === '' ? url : text, url };
}

/** Anchor with a value such as `Imports: 20`: the value comes from aria-label, else from the anchor text. */
function valueLink(container: HtmlElement | undefined, pageUrl: string, labelPattern: RegExp): Link | undefined {
  if (container === undefined) {
    return undefined;
  }
  const anchor = findFirst(container, byTag('a'));
  if (anchor === undefined) {
    return undefined;
  }
  const aria = attr(anchor, 'aria-label');
  const fromAria = aria !== undefined && labelPattern.test(aria) ? aria.replace(labelPattern, '').trim() : '';
  const text = fromAria !== '' ? fromAria : textWithoutLabel(anchor);
  return text === '' ? undefined : toLink(text, attr(anchor, 'href'), pageUrl);
}

function sanitizedChildren(el: HtmlElement | undefined, pageUrl: string): string | undefined {
  if (el === undefined) {
    return undefined;
  }
  const html = sanitizeNodes(el.children, { baseUrl: pageUrl });
  return html.trim() === '' ? undefined : html;
}

function extract(html: string, requestedPath: string): PackageDetail | undefined {
  const root = parseHtmlTree(html);
  const header = findFirst(root, byTag(SELECTORS.header.tag, SELECTORS.header.className));
  const aside = findFirst(root, byTag(SELECTORS.aside.tag, SELECTORS.aside.className));
  const article = findFirst(root, byTag(SELECTORS.article.tag, SELECTORS.article.className));
  const headerScope = header ?? root;
  const asideScope = aside ?? root;
  const articleScope = article ?? root;

  const titleEl = findFirst(headerScope, byAttr(SELECTORS.title.attr, SELECTORS.title.value, SELECTORS.title.tag));
  if (titleEl === undefined && article === undefined) {
    return undefined;
  }

  const pageUrl = `https://${PKG_GO_DEV_HOST}/${requestedPath}`;

  const breadcrumb = findFirst(
    headerScope,
    byAttr(SELECTORS.breadcrumbCurrent.attr, SELECTORS.breadcrumbCurrent.value, SELECTORS.breadcrumbCurrent.tag),
  );
  const clipboard = findFirst(
    headerScope,
    (el) => el.name === SELECTORS.clipboard.tag && hasClass(el, SELECTORS.clipboard.className) && attr(el, SELECTORS.clipboard.copyAttr) !== undefined,
  );
  const importPath =
    (breadcrumb === undefined ? '' : textContent(breadcrumb)) ||
    (clipboard === undefined ? '' : (attr(clipboard, SELECTORS.clipboard.copyAttr) ?? '').trim()) ||
    requestedPath;

  const title = (titleEl === undefined ? '' : textContent(titleEl)) || importPath.slice(importPath.lastIndexOf('/') + 1);

  const headerTitle = findFirst(headerScope, byClass(SELECTORS.headerTitle.className));
  const chips =
    headerTitle === undefined
      ? []
      : findAll(headerTitle, byTag(SELECTORS.chip.tag, SELECTORS.chip.className))
          .map((chip) => textContent(chip))
          .filter((text) => text !== '');

  const versionContainer = findFirst(headerScope, byAttr(SELECTORS.version.attr, SELECTORS.version.value));
  const version = valueLink(versionContainer, pageUrl, VERSION_PREFIX);

  const commitTime = findFirst(headerScope, byAttr(SELECTORS.commitTime.attr, SELECTORS.commitTime.value));
  const publishedText = commitTime === undefined ? '' : textContent(commitTime).replace(PUBLISHED_PREFIX, '').trim();

  const licenses: Link[] = [];
  for (const anchor of findAll(headerScope, byAttr(SELECTORS.license.attr, SELECTORS.license.value, SELECTORS.license.tag))) {
    const link = toLink(textContent(anchor), attr(anchor, 'href'), pageUrl);
    if (link !== undefined) {
      licenses.push(link);
    }
  }

  const imports = valueLink(
    findFirst(headerScope, byAttr(SELECTORS.imports.attr, SELECTORS.imports.value)),
    pageUrl,
    COUNT_PREFIX,
  );
  const importedBy = valueLink(
    findFirst(headerScope, byAttr(SELECTORS.importedBy.attr, SELECTORS.importedBy.value)),
    pageUrl,
    COUNT_PREFIX,
  );

  const checks: PackageCheck[] = [];
  const checkList = findFirst(asideScope, byTag(SELECTORS.checkList.tag, SELECTORS.checkList.className));
  if (checkList !== undefined) {
    for (const item of checkList.children) {
      if (item.kind !== 'element' || item.name !== SELECTORS.checkItem.tag) {
        continue;
      }
      const details = findFirst(item, byTag(SELECTORS.checkSummary.details));
      const summary = details === undefined ? undefined : findFirst(details, byTag(SELECTORS.checkSummary.tag));
      if (summary === undefined) {
        continue;
      }
      const label = textContent(summary);
      if (label === '') {
        continue;
      }
      const image = findFirst(summary, byTag(SELECTORS.checkImage.tag));
      checks.push({ label, ok: image !== undefined && attr(image, 'alt') === SELECTORS.checkImage.checkedAlt });
    }
  }

  const repoContainer = findFirst(asideScope, byClass(SELECTORS.repository.className));
  const repoAnchor = repoContainer === undefined ? undefined : findFirst(repoContainer, byTag(SELECTORS.repository.tag));
  const repository =
    repoAnchor === undefined ? undefined : toLink(textContent(repoAnchor), attr(repoAnchor, 'href'), pageUrl);

  const links: Link[] = [];
  const linkList = findFirst(asideScope, byTag(SELECTORS.links.tag, SELECTORS.links.className));
  if (linkList !== undefined) {
    for (const anchor of findAll(linkList, byTag(SELECTORS.links.link))) {
      const link = toLink(textContent(anchor) || (attr(anchor, 'title') ?? '').trim(), attr(anchor, 'href'), pageUrl);
      if (link !== undefined) {
        links.push(link);
      }
    }
  }

  const readmeHtml = sanitizedChildren(findFirst(articleScope, byClass(SELECTORS.readme.className)), pageUrl);
  const docHtml = sanitizedChildren(findFirst(articleScope, byClass(SELECTORS.doc.className)), pageUrl);

  let buildContext: PackageDetail['buildContext'];
  const select = findFirst(articleScope, byTag(SELECTORS.buildSelect.tag, SELECTORS.buildSelect.className));
  if (select !== undefined) {
    const options: BuildContextOption[] = [];
    let selected: string | undefined;
    for (const option of findAll(select, byTag(SELECTORS.buildSelect.option))) {
      const label = textContent(option);
      const value = (attr(option, 'value') ?? label).trim();
      if (value === '') {
        continue;
      }
      options.push({ value, label: label === '' ? value : label });
      if (selected === undefined && option.attrs.has(SELECTORS.buildSelect.selectedAttr)) {
        selected = value;
      }
    }
    const first = options[0];
    if (first !== undefined) {
      buildContext = { selected: selected ?? first.value, options };
    }
  }

  return {
    path: requestedPath,
    pageUrl,
    title,
    importPath,
    chips,
    ...(version === undefined ? {} : { version }),
    ...(publishedText === '' ? {} : { published: publishedText }),
    licenses,
    ...(imports === undefined ? {} : { imports }),
    ...(importedBy === undefined ? {} : { importedBy }),
    checks,
    ...(repository === undefined ? {} : { repository }),
    links,
    ...(readmeHtml === undefined ? {} : { readmeHtml }),
    ...(docHtml === undefined ? {} : { docHtml }),
    ...(buildContext === undefined ? {} : { buildContext }),
  };
}

/** Never throws. `undefined` when the page is not recognised as a pkg.go.dev package page. */
export function parsePackageDetail(html: string, requestedPath: string): PackageDetail | undefined {
  if (typeof html !== 'string' || typeof requestedPath !== 'string') {
    return undefined;
  }
  try {
    return extract(html, requestedPath);
  } catch {
    return undefined;
  }
}
