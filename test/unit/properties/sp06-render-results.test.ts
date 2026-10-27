import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PackageResult } from '../../../src/core/resultsParser';
import type { SearchViewModel } from '../../../src/core/searchProtocol';
import { renderState, type DomLike, type NodeLike } from '../../../src/webview/render';

const RUNS = 100;
const ALLOWED_TAGS = new Set(['li', 'button', 'span']);

/** Shared record of everything the renderer does to the fake DOM. */
interface DomLog {
  readonly createdTags: string[];
  readonly createdTexts: string[];
  readonly innerHtmlWrites: string[];
  replaceChildrenOnResults: number;
}

class FakeNode implements NodeLike {
  textContent: string | null = null;
  hidden?: boolean;
  readonly attrs = new Map<string, string>();
  children: FakeNode[] = [];

  constructor(
    readonly kind: 'element' | 'text',
    readonly tag: string,
    private readonly log: DomLog,
  ) {}

  get innerHTML(): string {
    return '';
  }

  set innerHTML(value: string) {
    this.log.innerHtmlWrites.push(value);
    throw new Error('innerHTML must never be written');
  }
}

class FakeDom implements DomLike<FakeNode> {
  readonly log: DomLog = {
    createdTags: [],
    createdTexts: [],
    innerHtmlWrites: [],
    replaceChildrenOnResults: 0,
  };
  resultsNode: FakeNode | undefined;

  createElement(tag: string): FakeNode {
    this.log.createdTags.push(tag);
    return new FakeNode('element', tag, this.log);
  }

  createTextNode(text: string): FakeNode {
    this.log.createdTexts.push(text);
    const node = new FakeNode('text', '#text', this.log);
    node.textContent = text;
    return node;
  }

  replaceChildren(parent: FakeNode, children: readonly FakeNode[]): void {
    if (parent === this.resultsNode) {
      this.log.replaceChildrenOnResults++;
    }
    parent.children = [...children];
  }

  setAttribute(node: FakeNode, name: string, value: string): void {
    node.attrs.set(name, value);
  }
}

function setup(): { dom: FakeDom; results: FakeNode; status: FakeNode; loading: FakeNode } {
  const dom = new FakeDom();
  const results = dom.createElement('ul');
  const status = dom.createElement('div');
  const loading = dom.createElement('div');
  dom.resultsNode = results;
  dom.log.createdTags.length = 0;
  return { dom, results, status, loading };
}

// Generators ---------------------------------------------------------------

const specialArb = fc.constantFrom(
  '<script>alert(1)</script>',
  '&amp;',
  '&lt;b&gt;',
  '&#60;',
  '"quoted"',
  "'single'",
  'Imported by 5',
  'published Jan 1',
  '<img src=x onerror=alert(1)>',
  '</span>',
  '<!--',
  '\u{1F600}',
  'a&b',
  '${x}',
  '{{x}}',
);

const valueArb: fc.Arbitrary<string> = fc.oneof(
  fc.string({ unit: 'grapheme', minLength: 1, maxLength: 30 }),
  specialArb,
  fc
    .array(fc.oneof(specialArb, fc.string({ unit: 'grapheme-ascii', minLength: 1, maxLength: 6 })), {
      minLength: 1,
      maxLength: 5,
    })
    .map((parts) => parts.join('')),
);

/** Exactly 280-420 code points, so the 300 code point boundary is exercised on both sides. */
const longSynopsisArb = fc
  .array(fc.constantFrom('a', 'b', ' ', '<', '&', '"', '\u{1F600}', '\u{20000}', 'é'), {
    minLength: 280,
    maxLength: 420,
  })
  .map((cps) => cps.join(''));

const synopsisArb = fc.oneof(valueArb, longSynopsisArb);

const resultArb: fc.Arbitrary<PackageResult> = fc.record(
  {
    path: valueArb,
    name: valueArb,
    synopsis: synopsisArb,
    version: valueArb,
    published: valueArb,
    importedBy: valueArb,
  },
  { requiredKeys: ['path', 'name'] },
);

const resultsArb = fc.array(resultArb, { maxLength: 8 });

// Helpers ------------------------------------------------------------------

function expectedSynopsis(text: string): string {
  const cps = Array.from(text);
  return cps.length > 300 ? `${cps.slice(0, 300).join('')}\u2026` : text;
}

function walk(node: FakeNode, visit: (n: FakeNode) => void): void {
  visit(node);
  for (const child of node.children) {
    walk(child, visit);
  }
}

function classOf(node: FakeNode): string | undefined {
  return node.attrs.get('class');
}

function textOf(node: FakeNode): string {
  let out = '';
  walk(node, (n) => {
    if (n.kind === 'text') {
      out += n.textContent ?? '';
    }
  });
  return out;
}

function expectSpan(node: FakeNode, className: string, text: string): void {
  expect(node.kind).toBe('element');
  expect(node.tag).toBe('span');
  expect(classOf(node)).toBe(className);
  expect(textOf(node)).toBe(text);
  expect(node.children.length).toBeGreaterThan(0);
  expect(node.children.every((c) => c.kind === 'text')).toBe(true);
}

function state(results: readonly PackageResult[], resultsVersion: number, status = '', loading = false): SearchViewModel {
  return { results, status, loading, resultsVersion };
}

function expectRendered(list: FakeNode, results: readonly PackageResult[], version: number): void {
  expect(list.children).toHaveLength(results.length);
  const describedBy = new Set<string>();

  results.forEach((result, index) => {
    const li = list.children[index]!;
    expect(li.tag).toBe('li');
    expect(classOf(li)).toBe('result');
    expect(li.children).toHaveLength(1);

    const button = li.children[0]!;
    expect(button.tag).toBe('button');
    expect(classOf(button)).toBe('result-button');
    expect(button.attrs.get('type')).toBe('button');
    expect(button.attrs.get('aria-label')).toBe(result.path);
    expect(button.attrs.get('data-version')).toBe(String(version));
    expect(button.attrs.get('data-index')).toBe(String(index));
    expect(button.children).toHaveLength(3);

    const [pathSpan, nameSpan, desc] = button.children as [FakeNode, FakeNode, FakeNode];
    expectSpan(pathSpan, 'result-path', result.path);
    expectSpan(nameSpan, 'result-name', result.name);

    expect(desc.tag).toBe('span');
    expect(classOf(desc)).toBe('result-desc');
    const descId = desc.attrs.get('id');
    expect(descId).toBeTruthy();
    expect(button.attrs.get('aria-describedby')).toBe(descId);
    describedBy.add(descId as string);

    const expectedChildren: Array<{ cls: string; text: string }> = [];
    if (result.synopsis !== undefined) {
      expectedChildren.push({ cls: 'result-synopsis', text: expectedSynopsis(result.synopsis) });
    }
    const meta: Array<{ cls: string; text: string }> = [];
    if (result.version !== undefined) {
      meta.push({ cls: 'result-version', text: result.version });
    }
    if (result.published !== undefined) {
      meta.push({ cls: 'result-published', text: `published ${result.published}` });
    }
    if (result.importedBy !== undefined) {
      meta.push({ cls: 'result-imported', text: `Imported by ${result.importedBy}` });
    }

    const descChildren = [...desc.children];
    for (const expected of expectedChildren) {
      const child = descChildren.shift();
      expect(child).toBeDefined();
      expectSpan(child as FakeNode, expected.cls, expected.text);
    }
    if (meta.length > 0) {
      const metaSpan = descChildren.shift();
      expect(metaSpan).toBeDefined();
      expect((metaSpan as FakeNode).tag).toBe('span');
      expect(classOf(metaSpan as FakeNode)).toBe('result-meta');
      expect((metaSpan as FakeNode).children).toHaveLength(meta.length);
      meta.forEach((expected, i) => {
        expectSpan((metaSpan as FakeNode).children[i]!, expected.cls, expected.text);
      });
    }
    // Absent fields produce nothing: no further children remain.
    expect(descChildren).toHaveLength(0);

    // All text of the entry is exactly the expected values, in order.
    const expectedText =
      result.path +
      result.name +
      expectedChildren.map((e) => e.text).join('') +
      meta.map((m) => m.text).join('');
    expect(textOf(li)).toBe(expectedText);
  });

  expect(describedBy.size).toBe(results.length);
}

function expectPlainTextOnly(dom: FakeDom, list: FakeNode): void {
  expect(dom.log.innerHtmlWrites).toEqual([]);
  expect(dom.log.createdTags.every((t) => ALLOWED_TAGS.has(t))).toBe(true);
  walk(list, (n) => {
    if (n === list) {
      return;
    }
    if (n.kind === 'text') {
      expect(n.children).toHaveLength(0);
      expect(n.textContent).not.toBe('');
    } else {
      expect(ALLOWED_TAGS.has(n.tag)).toBe(true);
      expect(n.textContent).toBeNull();
    }
  });
}

describe('Property 6', () => {
  // Feature: search-packages, Property 6: Results render as complete, ordered, plain-text entries
  // **Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.8, 5.3**
  it('renders one ordered, complete, plain-text entry per result', () => {
    fc.assert(
      fc.property(resultsArb, fc.nat({ max: 1000 }), (results, version) => {
        const { dom, results: list, status, loading } = setup();
        renderState(dom, { results: list, status, loading }, state(results, version));

        expectRendered(list, results, version);
        expectPlainTextOnly(dom, list);
        expect(dom.log.createdTags.filter((t) => t === 'li')).toHaveLength(results.length);
        expect(dom.log.createdTags.filter((t) => t === 'button')).toHaveLength(results.length);
      }),
      { numRuns: RUNS },
    );
  });

  // Feature: search-packages, Property 6: Results render as complete, ordered, plain-text entries
  // **Validates: Requirements 4.1, 4.8**
  it('rebuilds the list only when resultsVersion changes', () => {
    fc.assert(
      fc.property(
        resultsArb,
        resultsArb,
        fc.nat({ max: 1000 }),
        fc.nat({ max: 1000 }),
        fc.string({ maxLength: 20 }),
        fc.boolean(),
        (first, second, version, bump, statusText, isLoading) => {
          const { dom, results: list, status, loading } = setup();
          const elements = { results: list, status, loading };

          renderState(dom, elements, state(first, version));
          const before = [...list.children];
          const callsBefore = dom.log.replaceChildrenOnResults;
          expect(callsBefore).toBe(1);

          // Same version, different results/status/loading: the list is untouched.
          renderState(dom, elements, state(second, version, statusText, isLoading));
          expect(dom.log.replaceChildrenOnResults).toBe(callsBefore);
          expect(list.children).toHaveLength(before.length);
          list.children.forEach((child, i) => expect(child).toBe(before[i]));
          expectRendered(list, first, version);
          expect(status.textContent).toBe(statusText);
          expect(loading.hidden).toBe(!isLoading);

          // New version: rebuilt from the new results.
          const next = version + 1 + bump;
          renderState(dom, elements, state(second, next));
          expect(dom.log.replaceChildrenOnResults).toBe(callsBefore + 1);
          expectRendered(list, second, next);
          expectPlainTextOnly(dom, list);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
