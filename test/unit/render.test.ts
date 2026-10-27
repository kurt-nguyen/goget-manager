import { describe, expect, it } from 'vitest';
import type { SearchViewModel } from '../../src/core/searchProtocol';
import { renderState, type DomLike, type RenderElements } from '../../src/webview/render';

class FakeNode {
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  hidden = false;
  text: string | null = '';
  textAssignments = 0;
  constructor(readonly tag: string) {}
  get textContent(): string | null {
    return this.text;
  }
  set textContent(value: string | null) {
    this.textAssignments++;
    this.text = value;
  }
}

function createDom() {
  const replaced: FakeNode[] = [];
  const dom: DomLike<FakeNode> = {
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => {
      const node = new FakeNode('#text');
      node.text = text;
      return node;
    },
    replaceChildren: (parent, children) => {
      replaced.push(parent);
      parent.children = [...children];
    },
    setAttribute: (node, name, value) => {
      node.attrs[name] = value;
    },
  };
  const elements: RenderElements<FakeNode> = {
    results: new FakeNode('ul'),
    status: new FakeNode('div'),
    loading: new FakeNode('div'),
  };
  const listRebuilds = () => replaced.filter((node) => node === elements.results).length;
  return { dom, elements, listRebuilds };
}

function model(overrides: Partial<SearchViewModel> = {}): SearchViewModel {
  return {
    results: [
      { path: 'github.com/spf13/cobra', name: 'cobra', synopsis: 'A CLI library', version: 'v1.8.0' },
      { path: 'github.com/spf13/viper', name: 'viper' },
    ],
    status: '2 results',
    loading: false,
    resultsVersion: 1,
    ...overrides,
  };
}

describe('renderState (Req 1.1, 4.6, 5.1, 7.4)', () => {
  it('assigns the status text once when the same status is rendered twice', () => {
    const { dom, elements } = createDom();
    renderState(dom, elements, model());
    renderState(dom, elements, model());
    expect(elements.status.text).toBe('2 results');
    expect(elements.status.textAssignments).toBe(1);
  });

  it('assigns the status text again when it changes', () => {
    const { dom, elements } = createDom();
    renderState(dom, elements, model());
    renderState(dom, elements, model({ status: 'Searching…' }));
    expect(elements.status.text).toBe('Searching…');
    expect(elements.status.textAssignments).toBe(2);
  });

  it('does not rebuild the list when only status or loading change', () => {
    const { dom, elements, listRebuilds } = createDom();
    renderState(dom, elements, model());
    expect(listRebuilds()).toBe(1);
    const list = elements.results.children;

    renderState(dom, elements, model({ status: 'Searching…', loading: true }));
    renderState(dom, elements, model({ status: 'Searching…', loading: false }));
    expect(listRebuilds()).toBe(1);
    expect(elements.results.children).toBe(list);
  });

  it('rebuilds the list when resultsVersion changes', () => {
    const { dom, elements, listRebuilds } = createDom();
    renderState(dom, elements, model());
    renderState(dom, elements, model({ results: [{ path: 'a/b', name: 'b' }], resultsVersion: 2 }));
    expect(listRebuilds()).toBe(2);
    expect(elements.results.children).toHaveLength(1);
  });

  it('keeps independent render state per results element', () => {
    const first = createDom();
    const second = createDom();
    renderState(first.dom, first.elements, model());
    renderState(second.dom, second.elements, model());
    expect(second.listRebuilds()).toBe(1);
  });

  it('toggles hidden on the loading element', () => {
    const { dom, elements } = createDom();
    renderState(dom, elements, model({ loading: true }));
    expect(elements.loading.hidden).toBe(false);
    renderState(dom, elements, model({ loading: false }));
    expect(elements.loading.hidden).toBe(true);
    renderState(dom, elements, model({ loading: true }));
    expect(elements.loading.hidden).toBe(false);
  });

  it('renders each result as a li containing a button with version and index data', () => {
    const { dom, elements } = createDom();
    renderState(dom, elements, model({ resultsVersion: 4 }));
    const items = elements.results.children;
    expect(items.map((item) => item.tag)).toEqual(['li', 'li']);
    const button = items[1]!.children[0]!;
    expect(button.tag).toBe('button');
    expect(button.attrs).toMatchObject({
      type: 'button',
      'aria-label': 'github.com/spf13/viper',
      'data-version': '4',
      'data-index': '1',
      'data-path': 'github.com/spf13/viper',
    });
  });

  it('renders published and imported meta as icon spans with tooltips followed by the value', () => {
    const { dom, elements } = createDom();
    renderState(
      dom,
      elements,
      model({
        results: [
          { path: 'a/b', name: 'b', version: 'v1.0.0', published: 'Oct 6, 2026', importedBy: '1,289' },
        ],
      }),
    );
    const desc = elements.results.children[0]!.children[0]!.children[2]!;
    const meta = desc.children[0]!;
    expect(meta.attrs.class).toBe('result-meta');
    expect(meta.children.map((c) => c.attrs.class)).toEqual([
      'result-version',
      'result-published',
      'result-imported',
    ]);

    const [, published, imported] = meta.children as [FakeNode, FakeNode, FakeNode];
    expect(published.children).toHaveLength(2);
    expect(published.children[0]!.attrs).toEqual({
      class: 'result-icon icon-calendar',
      title: 'Publish date',
      role: 'img',
      'aria-label': 'Publish date',
    });
    expect(published.children[1]!.tag).toBe('#text');
    expect(published.children[1]!.text).toBe('Oct 6, 2026');
    expect(imported.children).toHaveLength(2);
    expect(imported.children[0]!.attrs).toEqual({
      class: 'result-icon icon-download',
      title: 'Number of import',
      role: 'img',
      'aria-label': 'Number of import',
    });
    expect(imported.children[1]!.tag).toBe('#text');
    expect(imported.children[1]!.text).toBe('1,289');

    const texts: string[] = [];
    const collect = (node: FakeNode): void => {
      if (node.tag === '#text') {
        texts.push(node.text ?? '');
      }
      node.children.forEach(collect);
    };
    collect(meta);
    expect(texts).not.toContain('published ');
    expect(texts).not.toContain('Imported by ');
  });

  it('omits meta spans for absent fields', () => {
    const { dom, elements } = createDom();
    renderState(dom, elements, model({ results: [{ path: 'a/b', name: 'b', published: 'Oct 6, 2026' }] }));
    const meta = elements.results.children[0]!.children[0]!.children[2]!.children[0]!;
    expect(meta.children.map((c) => c.attrs.class)).toEqual(['result-published']);
  });

  it('clears the list when the results are empty', () => {
    const { dom, elements } = createDom();
    renderState(dom, elements, model());
    renderState(dom, elements, model({ results: [], status: 'No packages found for "x".', resultsVersion: 2 }));
    expect(elements.results.children).toHaveLength(0);
    expect(elements.status.text).toBe('No packages found for "x".');
  });
});

describe('renderState installed badge', () => {
  const descOf = (item: FakeNode): FakeNode => item.children[0]!.children[2]!;
  const badgesIn = (desc: FakeNode): FakeNode[] =>
    desc.children.filter((c) => c.attrs.class === 'result-badge installed-badge');

  it('puts an Installed badge first in the description of an installed result only', () => {
    const { dom, elements } = createDom();
    renderState(dom, elements, model(), new Set(['github.com/spf13/cobra']));
    const [cobra, viper] = elements.results.children as [FakeNode, FakeNode];
    const desc = descOf(cobra);
    expect(desc.children[0]!.attrs.class).toBe('result-badge installed-badge');
    expect(desc.children[0]!.children.map((c) => c.text)).toEqual(['Installed']);
    expect(desc.children[1]!.attrs.class).toBe('result-synopsis');
    expect(badgesIn(descOf(viper))).toHaveLength(0);
  });

  it('badges a sub-package of an installed module but not a different major version', () => {
    const { dom, elements } = createDom();
    renderState(
      dom,
      elements,
      model({
        results: [
          { path: 'github.com/spf13/cobra/doc', name: 'doc' },
          { path: 'github.com/spf13/cobra/v2', name: 'cobra' },
        ],
      }),
      new Set(['github.com/spf13/cobra']),
    );
    const [doc, v2] = elements.results.children as [FakeNode, FakeNode];
    expect(badgesIn(descOf(doc))).toHaveLength(1);
    expect(badgesIn(descOf(v2))).toHaveLength(0);
  });

  it('rebuilds once when the installed flags change without a new resultsVersion', () => {
    const { dom, elements, listRebuilds } = createDom();
    renderState(dom, elements, model());
    expect(listRebuilds()).toBe(1);
    const installed = new Set(['github.com/spf13/cobra']);
    renderState(dom, elements, model(), installed);
    expect(listRebuilds()).toBe(2);
    renderState(dom, elements, model({ status: 'Searching', loading: true }), installed);
    expect(listRebuilds()).toBe(2);
  });

  it('does not rebuild when a different installed set yields the same flags', () => {
    const { dom, elements, listRebuilds } = createDom();
    renderState(dom, elements, model(), new Set(['github.com/spf13/cobra']));
    renderState(dom, elements, model(), new Set(['github.com/spf13/cobra', 'github.com/unrelated/mod']));
    expect(listRebuilds()).toBe(1);
  });

  it('renders no badge when no installed set is given', () => {
    const { dom, elements } = createDom();
    renderState(dom, elements, model());
    for (const item of elements.results.children) {
      expect(badgesIn(descOf(item))).toHaveLength(0);
    }
  });
});
