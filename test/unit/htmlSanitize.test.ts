import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveLink, sanitizeNodes } from '../../src/core/htmlSanitize';
import { tokenizeHtml } from '../../src/core/htmlTokens';
import { parseHtmlTree, type HtmlElement, type HtmlNode } from '../../src/core/htmlTree';

const BASE = 'https://pkg.go.dev/github.com/pkg/sftp/v2';
const hostile = readFileSync(join(__dirname, '..', 'fixtures', 'package-detail', 'hostile.html'), 'utf8');

function sanitize(html: string, baseUrl = BASE): string {
  return sanitizeNodes(parseHtmlTree(html).children, { baseUrl });
}

interface StartTag {
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
}

function startTags(html: string): StartTag[] {
  const tags: StartTag[] = [];
  for (const token of tokenizeHtml(html)) {
    if (token.kind === 'start') {
      tags.push({ name: token.name, attrs: token.attrs });
    }
  }
  return tags;
}

const sanitizedHostile = sanitize(hostile);

describe('sanitizeNodes on the hostile fixture', () => {
  it('drops dangerous tags together with their content', () => {
    const names = new Set(startTags(sanitizedHostile).map((t) => t.name));
    for (const banned of [
      'script', 'style', 'iframe', 'object', 'embed', 'form', 'svg', 'base', 'meta', 'select', 'option',
      'textarea', 'noscript', 'video', 'math', 'input', 'button', 'param', 'circle',
    ]) {
      expect(names.has(banned), banned).toBe(false);
    }
    for (const text of [
      'script body', 'display: none', 'iframe fallback', 'form input', 'form button', 'svg text', 'math text',
      'select option', 'textarea text', 'noscript text', 'video text',
    ]) {
      expect(sanitizedHostile).not.toContain(text);
    }
  });

  it('unwraps unknown tags but keeps their children', () => {
    const names = new Set(startTags(sanitizedHostile).map((t) => t.name));
    expect(names.has('custom-tag')).toBe(false);
    expect(names.has('blink')).toBe(false);
    expect(sanitizedHostile).toContain('unknown <b>bold</b>');
    expect(sanitizedHostile).toContain('blink text.');
  });

  it('only emits allowed attributes and no on* attributes', () => {
    const allowed = new Set([
      'class', 'id', 'title', 'lang', 'dir', 'href', 'rel', 'src', 'alt', 'width', 'height', 'loading',
      'referrerpolicy', 'colspan', 'rowspan', 'align', 'start', 'open',
    ]);
    for (const tag of startTags(sanitizedHostile)) {
      for (const name of tag.attrs.keys()) {
        expect(allowed.has(name), `${tag.name}[${name}]`).toBe(true);
        expect(name.startsWith('on')).toBe(false);
      }
    }
    expect(sanitizedHostile).not.toMatch(/\b(style|srcset|name|target|onerror|onclick|onload)=/u);
    expect(sanitizedHostile).not.toContain('data-x');
    expect(sanitizedHostile).not.toContain('aria-label');
  });

  it('prefixes ids with pd- and drops invalid ids', () => {
    const ids = startTags(sanitizedHostile)
      .map((t) => t.attrs.get('id'))
      .filter((v): v is string => v !== undefined);
    expect(ids).toEqual(expect.arrayContaining(['pd-postMessage', 'pd-readme-title', 'pd-Client.Chmod']));
    for (const id of ids) {
      expect(id.startsWith('pd-')).toBe(true);
    }
    expect(sanitizedHostile).not.toContain('bad id with spaces');
  });

  it('keeps only valid class tokens', () => {
    const h3 = startTags(sanitizedHostile).find((t) => t.name === 'h3');
    expect(h3?.attrs.get('class')).toBe('h2 bad');
  });

  it('emits no javascript:, data: or vbscript: URLs', () => {
    expect(sanitizedHostile).not.toMatch(/(?:javascript|vbscript|data|file):/iu);
    for (const tag of startTags(sanitizedHostile)) {
      for (const key of ['href', 'src']) {
        const value = tag.attrs.get(key);
        if (value !== undefined) {
          expect(value).toMatch(/^(?:https?:|mailto:|#pd-)/u);
        }
      }
    }
  });

  it('rewrites anchors: always rel, href only for safe links', () => {
    const anchors = startTags(sanitizedHostile).filter((t) => t.name === 'a');
    expect(anchors).toHaveLength(13);
    for (const anchor of anchors) {
      expect(anchor.attrs.get('rel')).toBe('noopener noreferrer');
    }
    const hrefs = anchors.map((a) => a.attrs.get('href')).filter((h): h is string => h !== undefined);
    expect(hrefs).toEqual([
      'https://example.com/ok?a=1&b=2',
      'mailto:dev@example.com',
      '#pd-readme-title',
      'https://pkg.go.dev/syscall#O_RDONLY',
      'https://pkg.go.dev/github.com/pkg/sftp/v2?tab=versions',
    ]);
    expect(sanitizedHostile).toContain('href="https://example.com/ok?a=1&amp;b=2"');
  });

  it('keeps only https images, resolved and hardened', () => {
    const images = startTags(sanitizedHostile).filter((t) => t.name === 'img');
    expect(images.map((i) => i.attrs.get('src'))).toEqual([
      'https://example.com/badge.svg',
      'https://pkg.go.dev/static/logo.png',
    ]);
    const first = images[0] as StartTag;
    expect(first.attrs.get('alt')).toBe('badge');
    expect(first.attrs.get('width')).toBe('10');
    expect(first.attrs.has('height')).toBe(false);
    for (const image of images) {
      expect(image.attrs.get('loading')).toBe('lazy');
      expect(image.attrs.get('referrerpolicy')).toBe('no-referrer');
    }
  });

  it('keeps table, list and details attributes from the allowlist', () => {
    const tags = startTags(sanitizedHostile);
    expect(tags.find((t) => t.name === 'th')?.attrs.get('colspan')).toBe('2');
    expect(tags.find((t) => t.name === 'th')?.attrs.get('align')).toBe('center');
    expect(tags.find((t) => t.name === 'td')?.attrs.get('rowspan')).toBe('3');
    expect(tags.find((t) => t.name === 'ol')?.attrs.get('start')).toBe('3');
    expect(tags.find((t) => t.name === 'ol')?.attrs.has('type')).toBe(false);
    expect(tags.find((t) => t.name === 'details')?.attrs.has('open')).toBe(true);
    expect(tags.find((t) => t.name === 'p')?.attrs.get('lang')).toBe('en');
    expect(tags.find((t) => t.name === 'p')?.attrs.get('dir')).toBe('rtl');
  });

  it('re-escapes text and decodes extra entities', () => {
    expect(sanitizedHostile).toContain('Title \u00a9 2026 \u2014 ok');
    expect(sanitizedHostile).toContain('title="tip \u00ae"');
    expect(sanitizedHostile).toContain('code &lt;script&gt;alert(15)&lt;/script&gt; &amp; more');
  });

});

describe('sanitizeNodes inline cases', () => {
  it('escapes text and attribute values', () => {
    expect(sanitize('<p title="a&quot;b&lt;c">1 &lt; 2 &amp; "3" &gt; 0</p>')).toBe(
      '<p title="a&quot;b&lt;c">1 &lt; 2 &amp; &quot;3&quot; &gt; 0</p>',
    );
  });

  it('decodes the extra named entities', () => {
    const entities = '&copy;&reg;&trade;&hellip;&mdash;&ndash;&rarr;&larr;&laquo;&raquo;&middot;&bull;&times;&ldquo;&rdquo;&lsquo;&rsquo;';
    expect(sanitize(`<p>${entities}</p>`)).toBe(
      '<p>\u00a9\u00ae\u2122\u2026\u2014\u2013\u2192\u2190\u00ab\u00bb\u00b7\u2022\u00d7\u201c\u201d\u2018\u2019</p>',
    );
    expect(sanitize('<p>&unknown; &copy</p>')).toBe('<p>&amp;unknown; &amp;copy</p>');
  });

  it('turns same-page hash links into #pd-<id>', () => {
    expect(sanitize('<a href="#pkg-index">i</a>')).toBe('<a href="#pd-pkg-index" rel="noopener noreferrer">i</a>');
    expect(sanitize('<a href="https://pkg.go.dev/github.com/pkg/sftp/v2?GOOS=windows#Client.Chmod">c</a>')).toBe(
      '<a href="#pd-Client.Chmod" rel="noopener noreferrer">c</a>',
    );
  });

  it('removes GOOS and GOARCH from pkg.go.dev links only', () => {
    expect(sanitize('<a href="https://pkg.go.dev/os?GOOS=windows&amp;GOARCH=amd64&amp;tab=doc">o</a>')).toBe(
      '<a href="https://pkg.go.dev/os?tab=doc" rel="noopener noreferrer">o</a>',
    );
    expect(sanitize('<a href="https://example.com/?GOOS=windows">o</a>')).toContain('href="https://example.com/?GOOS=windows"');
  });

  it('keeps an anchor without a usable href as a plain anchor', () => {
    expect(sanitize('<a href="javascript:alert(1)">x</a>')).toBe('<a rel="noopener noreferrer">x</a>');
    expect(sanitize('<a>x</a>')).toBe('<a rel="noopener noreferrer">x</a>');
  });

  it('drops non-https images entirely', () => {
    expect(sanitize('<p><img src="http://example.com/a.png" alt="x"></p>')).toBe('<p></p>');
    expect(sanitize('<p><img src="data:image/png;base64,AA" alt="x"></p>')).toBe('<p></p>');
    expect(sanitize('<p><img alt="x"></p>')).toBe('<p></p>');
    expect(sanitize('<img src="/a.png" alt="x">')).toBe(
      '<img src="https://pkg.go.dev/a.png" alt="x" loading="lazy" referrerpolicy="no-referrer">',
    );
  });

  it('renders void output tags without a closing tag', () => {
    expect(sanitize('<p>a<br>b<hr></p>')).toBe('<p>a<br>b<hr></p>');
  });

  it('handles very deep trees without throwing', () => {
    let node: HtmlNode = { kind: 'text', text: 'x' };
    for (let i = 0; i < 5000; i++) {
      const wrapper: HtmlElement = { kind: 'element', name: 'span', attrs: new Map(), children: [node] };
      node = wrapper;
    }
    expect(() => sanitizeNodes([node], { baseUrl: BASE })).not.toThrow();
  });

  it('returns an empty string for an empty or invalid input', () => {
    expect(sanitizeNodes([], { baseUrl: BASE })).toBe('');
    expect(sanitizeNodes(undefined as unknown as HtmlNode[], { baseUrl: BASE })).toBe('');
  });
});

describe('resolveLink', () => {
  it('resolves root-relative and query-relative links against the page', () => {
    expect(resolveLink('/github.com/spf13/cobra?tab=licenses', 'https://pkg.go.dev/github.com/spf13/cobra')).toEqual({
      kind: 'external',
      url: 'https://pkg.go.dev/github.com/spf13/cobra?tab=licenses',
    });
    expect(resolveLink('/syscall#O_RDONLY', BASE)).toEqual({ kind: 'external', url: 'https://pkg.go.dev/syscall#O_RDONLY' });
    expect(resolveLink('?tab=versions', BASE)).toEqual({ kind: 'external', url: `${BASE}?tab=versions` });
  });

  it('treats fragments as in-page links', () => {
    expect(resolveLink('#pkg-overview', BASE)).toEqual({ kind: 'fragment', id: 'pkg-overview' });
    expect(resolveLink('#a%20b', BASE)).toEqual({ kind: 'fragment', id: 'a b' });
    expect(resolveLink('#%E0%A4%A', BASE)).toEqual({ kind: 'fragment', id: '%E0%A4%A' });
  });

  it('treats same-page URLs with a hash as fragments, ignoring GOOS/GOARCH', () => {
    expect(resolveLink(`${BASE}?GOOS=windows#x`, BASE)).toEqual({ kind: 'fragment', id: 'x' });
    expect(resolveLink(`${BASE}#x`, `${BASE}?GOOS=windows`)).toEqual({ kind: 'fragment', id: 'x' });
    expect(resolveLink(`${BASE}?tab=versions#x`, BASE)).toEqual({ kind: 'external', url: `${BASE}?tab=versions#x` });
    expect(resolveLink('https://pkg.go.dev/os#x', BASE)).toEqual({ kind: 'external', url: 'https://pkg.go.dev/os#x' });
    expect(resolveLink(BASE, BASE)).toEqual({ kind: 'external', url: BASE });
  });

  it('strips GOOS and GOARCH from pkg.go.dev URLs', () => {
    expect(resolveLink('https://pkg.go.dev/os?GOOS=windows&GOARCH=amd64', BASE)).toEqual({
      kind: 'external',
      url: 'https://pkg.go.dev/os',
    });
  });

  it('keeps mailto and http(s) links', () => {
    expect(resolveLink('mailto:dev@example.com', BASE)).toEqual({ kind: 'external', url: 'mailto:dev@example.com' });
    expect(resolveLink('http://example.com/a', BASE)).toEqual({ kind: 'external', url: 'http://example.com/a' });
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    ' \u0001javascript:alert(1)',
    'data:text/html,hi',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'ftp://example.com/x',
    '',
    '   ',
    '#',
  ])('rejects %j', (raw) => {
    expect(resolveLink(raw, BASE)).toBeUndefined();
  });

  it('never throws on an invalid base', () => {
    expect(resolveLink('/x', 'not a url')).toBeUndefined();
    expect(resolveLink('https://example.com/x', 'not a url')).toBeUndefined();
  });
});
