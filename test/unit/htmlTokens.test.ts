import { describe, expect, it } from 'vitest';
import { decodeCharacterReferences, tokenizeHtml, type HtmlToken } from '../../src/core/htmlTokens';

function tokens(html: string): HtmlToken[] {
  return [...tokenizeHtml(html)];
}

function start(
  name: string,
  attrs: Record<string, string> = {},
  selfClosing = false,
): HtmlToken {
  return { kind: 'start', name, attrs: new Map(Object.entries(attrs)), selfClosing };
}

describe('tokenizeHtml tags', () => {
  it('emits start, text, and end tokens', () => {
    expect(tokens('<div>hello</div>')).toEqual([
      start('div'),
      { kind: 'text', text: 'hello' },
      { kind: 'end', name: 'div' },
    ]);
  });

  it('lowercases tag and attribute names', () => {
    expect(tokens('<DIV CLASS="a"></DIV>')).toEqual([
      start('div', { class: 'a' }),
      { kind: 'end', name: 'div' },
    ]);
  });

  it('reads double-quoted, single-quoted, and unquoted attribute values', () => {
    expect(tokens(`<a href="/x" title='y z' data-n=42 hidden>`)).toEqual([
      start('a', { href: '/x', title: 'y z', 'data-n': '42', hidden: '' }),
    ]);
  });

  it('allows the other quote character and ">" inside a quoted value', () => {
    expect(tokens(`<a a="it's > ok" b='say "hi"'>`)).toEqual([
      start('a', { a: "it's > ok", b: 'say "hi"' }),
    ]);
  });

  it('tolerates whitespace around the equals sign', () => {
    expect(tokens('<a  href = "/x"   id\n=\ty >')).toEqual([start('a', { href: '/x', id: 'y' })]);
  });

  it('keeps the first of duplicate attributes', () => {
    expect(tokens('<a x="1" x="2">')).toEqual([start('a', { x: '1' })]);
  });

  it('marks self-closing tags', () => {
    expect(tokens('<br/><br /><img src="a.png"/>')).toEqual([
      start('br', {}, true),
      start('br', {}, true),
      start('img', { src: 'a.png' }, true),
    ]);
  });

  it('does not mark a plain void tag as self-closing', () => {
    expect(tokens('<br>')).toEqual([start('br')]);
  });

  it('ignores whitespace and extra attributes in an end tag', () => {
    expect(tokens('</div >')).toEqual([{ kind: 'end', name: 'div' }]);
    expect(tokens('</DIV class="x">')).toEqual([{ kind: 'end', name: 'div' }]);
  });

  it('treats "<" not followed by a tag opener as text', () => {
    expect(tokens('a < b <3 c<')).toEqual([{ kind: 'text', text: 'a < b <3 c<' }]);
  });

  it('decodes references in text and attribute values', () => {
    expect(tokens('<a t="a&amp;b">x &lt; y</a>')).toEqual([
      start('a', { t: 'a&b' }),
      { kind: 'text', text: 'x < y' },
      { kind: 'end', name: 'a' },
    ]);
  });

  it('emits leading and trailing text around tags', () => {
    expect(tokens('a<b>c</b>d')).toEqual([
      { kind: 'text', text: 'a' },
      start('b'),
      { kind: 'text', text: 'c' },
      { kind: 'end', name: 'b' },
      { kind: 'text', text: 'd' },
    ]);
  });

  it('yields nothing for empty or non-string input', () => {
    expect(tokens('')).toEqual([]);
    expect([...tokenizeHtml(undefined as unknown as string)]).toEqual([]);
  });
});

describe('tokenizeHtml comments and declarations', () => {
  it('skips comments, including ones containing tags', () => {
    expect(tokens('<p>a<!-- <b>x</b> -->b</p>')).toEqual([
      start('p'),
      { kind: 'text', text: 'a' },
      { kind: 'text', text: 'b' },
      { kind: 'end', name: 'p' },
    ]);
  });

  it('skips <!DOCTYPE> and processing instructions', () => {
    expect(tokens('<!DOCTYPE html><?xml version="1.0"?><html></html>')).toEqual([
      start('html'),
      { kind: 'end', name: 'html' },
    ]);
  });

  it('skips a comment containing ">" until "-->"', () => {
    expect(tokens('<!-- a > b --><i>')).toEqual([start('i')]);
  });
});

describe('tokenizeHtml raw-text elements', () => {
  it('skips script content containing fake tags', () => {
    const html = '<script>var s = "<div class=\\"SearchSnippet\\">"; </div></script><p>';
    expect(tokens(html)).toEqual([start('script'), { kind: 'end', name: 'script' }, start('p')]);
  });

  it('skips style content containing fake tags', () => {
    expect(tokens('<style>a::before{content:"</p><b>"}</style><i>')).toEqual([
      start('style'),
      { kind: 'end', name: 'style' },
      start('i'),
    ]);
  });

  it('matches the closing tag case-insensitively', () => {
    expect(tokens('<SCRIPT><b></ScRiPt>x')).toEqual([
      start('script'),
      { kind: 'end', name: 'script' },
      { kind: 'text', text: 'x' },
    ]);
  });

  it('is not ended by a different tag whose name starts with the raw-text name', () => {
    expect(tokens('<script></scripts><b></script>')).toEqual([
      start('script'),
      { kind: 'end', name: 'script' },
    ]);
  });

  it('skips textarea and title content', () => {
    expect(tokens('<title><b>x</title><textarea><i></textarea>')).toEqual([
      start('title'),
      { kind: 'end', name: 'title' },
      start('textarea'),
      { kind: 'end', name: 'textarea' },
    ]);
  });

  it('drops an unterminated script body and ends', () => {
    expect(tokens('<p><script><b>x</b>')).toEqual([start('p'), start('script')]);
  });

  it('does not skip content after a self-closing script', () => {
    expect(tokens('<script/><b>')).toEqual([start('script', {}, true), start('b')]);
  });
});

describe('decodeCharacterReferences', () => {
  it.each([
    ['&amp;', '&'],
    ['&lt;', '<'],
    ['&gt;', '>'],
    ['&quot;', '"'],
    ['&apos;', "'"],
    ['&nbsp;', '\u00a0'],
  ])('decodes named reference %s', (input, expected) => {
    expect(decodeCharacterReferences(input)).toBe(expected);
  });

  it.each([
    ['&#34;', '"'],
    ['&#39;', "'"],
    ['&#43;', '+'],
    ['&#65;', 'A'],
    ['&#x41;', 'A'],
    ['&#X2b;', '+'],
    ['&#x1F600;', '\u{1F600}'],
  ])('decodes numeric reference %s', (input, expected) => {
    expect(decodeCharacterReferences(input)).toBe(expected);
  });

  it.each([
    ['&#0;'],
    ['&#x0;'],
    ['&#xD800;'],
    ['&#55357;'],
    ['&#x110000;'],
    ['&#1114112;'],
    ['&#99999999999999999999999;'],
  ])('replaces invalid numeric reference %s with U+FFFD', (input) => {
    expect(decodeCharacterReferences(input)).toBe('\uFFFD');
  });

  it('keeps unknown named references literal', () => {
    expect(decodeCharacterReferences('&copy; &foo;')).toBe('&copy; &foo;');
  });

  it('keeps references without a semicolon literal', () => {
    expect(decodeCharacterReferences('&amp &#43')).toBe('&amp &#43');
  });

  it('decodes in a single pass', () => {
    expect(decodeCharacterReferences('&amp;lt;')).toBe('&lt;');
  });

  it('decodes several references in one string', () => {
    expect(decodeCharacterReferences('a&amp;b&#43;c&lt;')).toBe('a&b+c<');
  });

  it('returns text without "&" unchanged', () => {
    expect(decodeCharacterReferences('plain text')).toBe('plain text');
  });
});

describe('tokenizeHtml unterminated input', () => {
  it('drops an unterminated start tag and ends tokenization', () => {
    expect(tokens('<p>a<span class="x"')).toEqual([start('p'), { kind: 'text', text: 'a' }]);
    expect(tokens('<p>a<span')).toEqual([start('p'), { kind: 'text', text: 'a' }]);
    expect(tokens('<p>a<span x=')).toEqual([start('p'), { kind: 'text', text: 'a' }]);
  });

  it('drops an unterminated end tag', () => {
    expect(tokens('<p>a</p')).toEqual([start('p'), { kind: 'text', text: 'a' }]);
  });

  it('drops an unterminated comment and ends tokenization', () => {
    expect(tokens('<p>x</p><!-- never closed <b>')).toEqual([
      start('p'),
      { kind: 'text', text: 'x' },
      { kind: 'end', name: 'p' },
    ]);
  });

  it('drops an unterminated declaration', () => {
    expect(tokens('<i><!DOCTYPE html')).toEqual([start('i')]);
  });

  it('drops a tag with an unterminated quoted value, even when later markup exists', () => {
    expect(tokens('<a href="foo>text</a>')).toEqual([]);
    expect(tokens(`<a href='foo><b>`)).toEqual([]);
  });

  it('does not throw on truncations of a document', () => {
    const html = '<!DOCTYPE html><!-- c --><div id="a" class=\'b\' x=y><br/>t&amp;u</div>';
    for (let cut = 0; cut <= html.length; cut++) {
      expect(() => tokens(html.slice(0, cut))).not.toThrow();
    }
  });
});
