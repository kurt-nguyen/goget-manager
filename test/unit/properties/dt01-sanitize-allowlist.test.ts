import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitizeNodes } from '../../../src/core/htmlSanitize';
import { tokenizeHtml } from '../../../src/core/htmlTokens';
import { parseHtmlTree } from '../../../src/core/htmlTree';

const RUNS = 300;
const BASE = 'https://pkg.go.dev/github.com/pkg/sftp/v2';

const ALLOWED_TAGS = new Set(
  (
    'a abbr article b blockquote br caption code col colgroup dd del details div dl dt em figcaption figure ' +
    'h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp section small span strong sub summary sup ' +
    'table tbody td tfoot th thead tr tt u ul var'
  ).split(' '),
);
const ALLOWED_ATTRS = new Set([
  'class', 'id', 'title', 'lang', 'dir', 'href', 'rel', 'src', 'alt', 'width', 'height', 'loading',
  'referrerpolicy', 'colspan', 'rowspan', 'align', 'start', 'open',
]);

const tagNames = [
  'a', 'b', 'p', 'div', 'span', 'img', 'ul', 'li', 'table', 'tr', 'td', 'pre', 'details', 'summary', 'h3', 'ol',
  'script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'svg', 'math', 'select', 'textarea', 'base',
  'meta', 'link', 'video', 'noscript', 'custom-tag', 'font', 'center', 'marquee',
];
const attrNames = [
  'href', 'src', 'srcset', 'style', 'onclick', 'onerror', 'onload', 'ONMOUSEOVER', 'id', 'class', 'name', 'target',
  'title', 'alt', 'width', 'height', 'colspan', 'start', 'open', 'data-x', 'aria-label', 'formaction', 'lang', 'dir',
];
const urls = [
  'https://example.com/a', 'http://example.com/a', '/syscall#O_RDONLY', '?tab=versions', '#frag', '#', '',
  'mailto:a@b.c', 'javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'jav&#x61;script:alert(1)', 'java\tscript:alert(1)',
  'data:text/html,x', 'vbscript:x', 'file:///x', 'ftp://x/y', '//evil.example/x', ' javascript:x',
  'https://pkg.go.dev/os?GOOS=windows#x', BASE + '?GOOS=linux#top',
];

const valueArb = fc.oneof(
  fc.constantFrom(...urls),
  fc.string({ maxLength: 12 }),
  fc.constantFrom('a b', 'x"y', "x'y", '1', '99', 'center', 'pd-x', 'a&amp;b'),
);
const quoteArb = fc.constantFrom('"', "'", '');
const attrArb = fc
  .tuple(fc.constantFrom(...attrNames), fc.option(fc.tuple(quoteArb, valueArb), { nil: undefined }))
  .map(([name, rest]) => {
    if (rest === undefined) {
      return name;
    }
    const [quote, value] = rest;
    const safe = quote === '' ? value.replace(/[\s>"'=`]/gu, '') : value.split(quote).join('');
    return `${name}=${quote}${safe}${quote}`;
  });
const startArb = fc
  .tuple(fc.constantFrom(...tagNames), fc.array(attrArb, { maxLength: 4 }), fc.boolean())
  .map(([name, attrs, selfClosing]) => `<${name}${attrs.map((a) => ` ${a}`).join('')}${selfClosing ? '/' : ''}>`);
const endArb = fc.constantFrom(...tagNames).map((name) => `</${name}>`);
const textArb = fc.oneof(
  fc.string({ maxLength: 12 }),
  fc.constantFrom('&lt;script&gt;', '&copy;', '&amp;lt;', '<', '>', '"', "'", '<!-- c -->', 'text'),
);
const fragmentsArb = fc
  .array(fc.oneof(startArb, startArb, endArb, textArb), { maxLength: 40 })
  .map((parts) => parts.join(''));

describe('dt01: sanitizer output only contains allowlisted markup', () => {
  it('emits only allowed tags and attributes with safe URL schemes', () => {
    fc.assert(
      fc.property(fragmentsArb, (html) => {
        const output = sanitizeNodes(parseHtmlTree(html).children, { baseUrl: BASE });
        for (const token of tokenizeHtml(output)) {
          if (token.kind !== 'start') {
            if (token.kind === 'end') {
              expect(ALLOWED_TAGS.has(token.name)).toBe(true);
            }
            continue;
          }
          expect(ALLOWED_TAGS.has(token.name)).toBe(true);
          for (const [name, value] of token.attrs) {
            expect(ALLOWED_ATTRS.has(name)).toBe(true);
            expect(name.startsWith('on')).toBe(false);
            if (name === 'href') {
              expect(value).toMatch(/^(?:https?:|mailto:|#)/u);
            }
            if (name === 'src') {
              expect(value).toMatch(/^https:/u);
            }
            if (name === 'id') {
              expect(value.startsWith('pd-')).toBe(true);
            }
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('never throws and never leaves a raw < in text', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 300 }), (html) => {
        const output = sanitizeNodes(parseHtmlTree(html).children, { baseUrl: BASE });
        expect(typeof output).toBe('string');
        expect(output).not.toMatch(/<(?!\/?[a-z][a-z0-9]*[\s>/])/u);
      }),
      { numRuns: RUNS },
    );
  });
});
