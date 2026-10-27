import { describe, expect, it } from 'vitest';
import {
  attr,
  findAll,
  findFirst,
  hasClass,
  MAX_TREE_DEPTH,
  parseHtmlTree,
  textContent,
  type HtmlElement,
  type HtmlNode,
} from '../../src/core/htmlTree';

function names(el: HtmlElement): string[] {
  return el.children.filter((c): c is HtmlElement => c.kind === 'element').map((c) => c.name);
}

function depthOf(node: HtmlNode): number {
  let max = 0;
  const stack: { node: HtmlNode; depth: number }[] = [{ node, depth: 0 }];
  while (stack.length > 0) {
    const { node: current, depth } = stack.pop() as { node: HtmlNode; depth: number };
    max = Math.max(max, depth);
    if (current.kind === 'element') {
      for (const child of current.children) {
        stack.push({ node: child, depth: depth + 1 });
      }
    }
  }
  return max;
}

describe('parseHtmlTree', () => {
  it('returns a synthetic root', () => {
    const root = parseHtmlTree('<p>x</p>');
    expect(root.name).toBe('#root');
    expect(names(root)).toEqual(['p']);
  });

  it('nests elements and keeps text and attributes', () => {
    const root = parseHtmlTree('<div id="a"><p>one</p><p>two <b>bold</b></p></div>');
    const div = root.children[0] as HtmlElement;
    expect(div.name).toBe('div');
    expect(attr(div, 'id')).toBe('a');
    expect(names(div)).toEqual(['p', 'p']);
    expect(textContent(root)).toBe('onetwo bold');
  });

  it('does not push void elements or self-closing elements', () => {
    const root = parseHtmlTree('<p>a<br>b<img src="x"><hr/>c<span/>d</p>');
    const p = root.children[0] as HtmlElement;
    expect(names(p)).toEqual(['br', 'img', 'hr', 'span']);
    expect(p.children.filter((c) => c.kind === 'text').map((c) => (c as { text: string }).text)).toEqual([
      'a',
      'b',
      'c',
      'd',
    ]);
    for (const child of p.children) {
      if (child.kind === 'element') {
        expect(child.children).toEqual([]);
      }
    }
  });

  it('ignores stray end tags', () => {
    const root = parseHtmlTree('</div><p>x</p></span>y');
    expect(names(root)).toEqual(['p']);
    expect(textContent(root)).toBe('xy');
  });

  it('closes the nearest open ancestor and pops the elements above it', () => {
    const root = parseHtmlTree('<div><b><i>x</div>after');
    const div = root.children[0] as HtmlElement;
    expect(div.name).toBe('div');
    expect(textContent(div)).toBe('x');
    expect(root.children[1]).toEqual({ kind: 'text', text: 'after' });
  });

  it('closes the nearest ancestor with the same name', () => {
    const root = parseHtmlTree('<div id="outer"><div id="inner">a</div>b</div>c');
    const outer = root.children[0] as HtmlElement;
    expect(names(outer)).toEqual(['div']);
    expect(textContent(outer)).toBe('ab');
    expect(root.children[1]).toEqual({ kind: 'text', text: 'c' });
  });

  it('caps the depth without throwing for 10_000 nested elements', () => {
    const html = '<div>'.repeat(10_000) + 'deep' + '</div>'.repeat(10_000) + '<p>after</p>';
    let root: HtmlElement | undefined;
    expect(() => {
      root = parseHtmlTree(html);
    }).not.toThrow();
    // Elements deeper than the cap hang off the cap-depth node, so the tree depth stays bounded by the cap.
    expect(depthOf(root as HtmlElement)).toBeLessThanOrEqual(MAX_TREE_DEPTH);
    expect(textContent(root as HtmlElement)).toContain('deep');
    expect(findFirst(root as HtmlElement, (el) => el.name === 'p')).toBeDefined();
  });

  it('never throws on malformed input', () => {
    for (const html of ['', '<', '<div', '<div class="', '</', '<<>>', '\u0000<p>', '<p>unterminated <b']) {
      expect(() => parseHtmlTree(html)).not.toThrow();
    }
    expect(() => parseHtmlTree(undefined as unknown as string)).not.toThrow();
  });
});

describe('tree helpers', () => {
  const root = parseHtmlTree(
    '<div class="a b" id="x"><p class="b">one</p><ul><li class="b">two</li><li>three</li></ul></div><p>four</p>',
  );

  it('findFirst returns the first descendant in document order', () => {
    expect(findFirst(root, (el) => hasClass(el, 'b'))?.name).toBe('div');
    expect(textContent(findFirst(root, (el) => el.name === 'li') as HtmlElement)).toBe('two');
    expect(findFirst(root, (el) => el.name === 'table')).toBeUndefined();
  });

  it('findFirst and findAll exclude the node itself', () => {
    const div = findFirst(root, (el) => el.name === 'div') as HtmlElement;
    expect(findFirst(div, (el) => el.name === 'div')).toBeUndefined();
    expect(findAll(div, (el) => el.name === 'div')).toEqual([]);
  });

  it('findAll returns matches in document order', () => {
    expect(findAll(root, (el) => hasClass(el, 'b')).map((el) => el.name)).toEqual(['div', 'p', 'li']);
    expect(findAll(root, (el) => el.name === 'p').map((el) => textContent(el))).toEqual(['one', 'four']);
  });

  it('hasClass matches whole class tokens', () => {
    const div = findFirst(root, (el) => el.name === 'div') as HtmlElement;
    expect(hasClass(div, 'a')).toBe(true);
    expect(hasClass(div, 'b')).toBe(true);
    expect(hasClass(div, 'ab')).toBe(false);
    expect(hasClass(div, 'a b')).toBe(true);
    expect(hasClass(root, 'a')).toBe(false);
  });

  it('attr returns the attribute value or undefined', () => {
    const div = findFirst(root, (el) => el.name === 'div') as HtmlElement;
    expect(attr(div, 'id')).toBe('x');
    expect(attr(div, 'missing')).toBeUndefined();
  });

  it('textContent collapses whitespace and trims', () => {
    const tree = parseHtmlTree('<p>  hello \n\t  <b> big\n world </b>  !  </p>');
    expect(textContent(tree)).toBe('hello big world !');
    expect(textContent({ kind: 'text', text: '  a \n b ' })).toBe('a b');
  });

  it('textContent skips script and style bodies (tokenizer drops them)', () => {
    expect(textContent(parseHtmlTree('<p>a<script>evil()</script><style>x{}</style>b</p>'))).toBe('ab');
  });
});
