import type { HtmlElement, HtmlNode } from './htmlTree';
import { PKG_GO_DEV_HOST } from './searchQuery';

export interface SanitizeContext {
  /** Absolute URL of the scraped page; relative links and images are resolved against it. */
  readonly baseUrl: string;
}

export type ResolvedLink =
  | { readonly kind: 'fragment'; readonly id: string }
  | { readonly kind: 'external'; readonly url: string };

const ALLOWED_TAGS: ReadonlySet<string> = new Set(
  (
    'a abbr article b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure ' +
    'h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp section small span strong sub summary sup ' +
    'table tbody td tfoot th thead tr tt u ul var'
  ).split(' '),
);

const DROPPED_TAGS: ReadonlySet<string> = new Set(
  (
    'script style iframe frame frameset object embed applet form template noscript textarea select option ' +
    'button input link meta base svg math audio video canvas dialog title head'
  ).split(' '),
);

const VOID_OUTPUT_TAGS: ReadonlySet<string> = new Set(['br', 'col', 'hr', 'img']);

const CLASS_TOKEN = /^[A-Za-z][\w-]*$/u;
const ID_VALUE = /^[\w:.-]+$/u;
const DIGITS = /^\d{1,6}$/u;
const WORD = /^[A-Za-z]{1,16}$/u;
const LANG = /^[A-Za-z0-9-]{1,35}$/u;
const MAX_DEPTH = 512;
const ID_PREFIX = 'pd-';
const LINK_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:']);

const EXTRA_ENTITIES: Readonly<Record<string, string>> = {
  copy: '\u00a9',
  reg: '\u00ae',
  trade: '\u2122',
  hellip: '\u2026',
  mdash: '\u2014',
  ndash: '\u2013',
  rarr: '\u2192',
  larr: '\u2190',
  laquo: '\u00ab',
  raquo: '\u00bb',
  middot: '\u00b7',
  bull: '\u2022',
  times: '\u00d7',
  ldquo: '\u201c',
  rdquo: '\u201d',
  lsquo: '\u2018',
  rsquo: '\u2019',
};

const EXTRA_ENTITY = new RegExp(`&(${Object.keys(EXTRA_ENTITIES).join('|')});`, 'gu');

function decodeExtraEntities(text: string): string {
  return text.indexOf('&') === -1 ? text : text.replace(EXTRA_ENTITY, (_m, name: string) => EXTRA_ENTITIES[name] as string);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/gu, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

function stripBuildParams(url: URL): void {
  if (url.hostname === PKG_GO_DEV_HOST) {
    url.searchParams.delete('GOOS');
    url.searchParams.delete('GOARCH');
  }
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Resolves `raw` against `baseUrl`. Only http, https and mailto survive.
 * A link that points at a fragment of the same page (ignoring GOOS/GOARCH) is a `fragment`.
 */
export function resolveLink(raw: string, baseUrl: string): ResolvedLink | undefined {
  try {
    if (typeof raw !== 'string' || raw.trim() === '' || raw.trim() === '#') {
      return undefined;
    }
    const url = new URL(raw, baseUrl);
    if (!LINK_PROTOCOLS.has(url.protocol)) {
      return undefined;
    }
    if (url.protocol !== 'mailto:') {
      const base = new URL(baseUrl);
      const target = new URL(url.href);
      stripBuildParams(target);
      stripBuildParams(base);
      if (
        url.hash.length > 1 &&
        target.origin === base.origin &&
        target.pathname === base.pathname &&
        target.search === base.search
      ) {
        return { kind: 'fragment', id: safeDecode(url.hash.slice(1)) };
      }
      stripBuildParams(url);
    }
    return { kind: 'external', url: url.href };
  } catch {
    return undefined;
  }
}

function resolveImage(raw: string, baseUrl: string): string | undefined {
  try {
    const url = new URL(raw, baseUrl);
    return url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function classValue(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const tokens = raw.split(/\s+/u).filter((token) => CLASS_TOKEN.test(token));
  return tokens.length > 0 ? tokens.join(' ') : undefined;
}

function attribute(name: string, value: string): string {
  return ` ${name}="${escapeHtml(value)}"`;
}

function globalAttributes(el: HtmlElement): string {
  let out = '';
  const cls = classValue(el.attrs.get('class'));
  if (cls !== undefined) {
    out += attribute('class', cls);
  }
  const id = el.attrs.get('id');
  if (id !== undefined && ID_VALUE.test(id)) {
    out += attribute('id', ID_PREFIX + id);
  }
  const title = el.attrs.get('title');
  if (title !== undefined) {
    out += attribute('title', decodeExtraEntities(title));
  }
  const lang = el.attrs.get('lang');
  if (lang !== undefined && LANG.test(lang)) {
    out += attribute('lang', lang);
  }
  const dir = el.attrs.get('dir');
  if (dir !== undefined && /^(?:ltr|rtl|auto)$/iu.test(dir)) {
    out += attribute('dir', dir.toLowerCase());
  }
  return out;
}

function numericAttribute(el: HtmlElement, name: string): string {
  const value = el.attrs.get(name);
  return value !== undefined && DIGITS.test(value) ? attribute(name, value) : '';
}

/** Opening tag for an allowed element, or `undefined` when the element must be dropped entirely. */
function openTag(el: HtmlElement, ctx: SanitizeContext): string | undefined {
  const name = el.name;
  let out = `<${name}${globalAttributes(el)}`;
  switch (name) {
    case 'a': {
      const href = el.attrs.get('href');
      const link = href === undefined ? undefined : resolveLink(href, ctx.baseUrl);
      if (link !== undefined) {
        out += attribute('href', link.kind === 'fragment' ? `#${ID_PREFIX}${encodeURIComponent(link.id)}` : link.url);
      }
      out += ' rel="noopener noreferrer"';
      break;
    }
    case 'img': {
      const src = el.attrs.get('src');
      const resolved = src === undefined ? undefined : resolveImage(src, ctx.baseUrl);
      if (resolved === undefined) {
        return undefined;
      }
      out += attribute('src', resolved);
      const alt = el.attrs.get('alt');
      if (alt !== undefined) {
        out += attribute('alt', decodeExtraEntities(alt));
      }
      out += numericAttribute(el, 'width') + numericAttribute(el, 'height');
      out += ' loading="lazy" referrerpolicy="no-referrer"';
      break;
    }
    case 'td':
    case 'th': {
      out += numericAttribute(el, 'colspan') + numericAttribute(el, 'rowspan');
      const align = el.attrs.get('align');
      if (align !== undefined && WORD.test(align)) {
        out += attribute('align', align.toLowerCase());
      }
      break;
    }
    case 'ol':
      out += numericAttribute(el, 'start');
      break;
    case 'details':
      if (el.attrs.has('open')) {
        out += ' open';
      }
      break;
    default:
      break;
  }
  return `${out}>`;
}

function write(nodes: readonly HtmlNode[], ctx: SanitizeContext, depth: number, out: string[]): void {
  if (depth > MAX_DEPTH) {
    return;
  }
  for (const node of nodes) {
    if (node.kind === 'text') {
      out.push(escapeHtml(decodeExtraEntities(node.text)));
      continue;
    }
    const name = node.name;
    if (DROPPED_TAGS.has(name)) {
      continue;
    }
    if (!ALLOWED_TAGS.has(name)) {
      write(node.children, ctx, depth + 1, out);
      continue;
    }
    const open = openTag(node, ctx);
    if (open === undefined) {
      continue;
    }
    out.push(open);
    if (VOID_OUTPUT_TAGS.has(name)) {
      continue;
    }
    write(node.children, ctx, depth + 1, out);
    out.push(`</${name}>`);
  }
}

/** Allowlist sanitizer: returns safe HTML for the given nodes. Never throws (returns '' on failure). */
export function sanitizeNodes(nodes: readonly HtmlNode[], ctx: SanitizeContext): string {
  try {
    const out: string[] = [];
    write(nodes, ctx, 0, out);
    return out.join('');
  } catch {
    return '';
  }
}
