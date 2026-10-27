import { describe, expect, it } from 'vitest';
import type { PackageDetail } from '../../src/core/packageDetail';
import {
  ACTION_ID,
  CHECK_NO,
  CHECK_YES,
  GOOS_SELECT_ID,
  IDLE_TEXT,
  RETRY_CLASS,
  renderGoosSelect,
  renderHeader,
  renderRetry,
  renderStatus,
  setInstalledButton,
} from '../../src/webview/detailRender';
import type { DomLike } from '../../src/webview/render';

class FakeNode {
  children: FakeNode[] = [];
  attrs: Record<string, string> = {};
  hidden = false;
  textContent: string | null = '';
  constructor(readonly tag: string) {}
  /** All text of this subtree. */
  get text(): string {
    return this.tag === '#text' ? (this.textContent ?? '') : this.children.map((c) => c.text).join('');
  }
  find(pred: (node: FakeNode) => boolean): FakeNode | undefined {
    for (const child of this.children) {
      if (pred(child)) return child;
      const nested = child.find(pred);
      if (nested) return nested;
    }
    return undefined;
  }
  findAll(pred: (node: FakeNode) => boolean): FakeNode[] {
    return this.children.flatMap((child) => [...(pred(child) ? [child] : []), ...child.findAll(pred)]);
  }
}

const dom: DomLike<FakeNode> = {
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => {
    const node = new FakeNode('#text');
    node.textContent = text;
    return node;
  },
  replaceChildren: (parent, children) => {
    parent.children = [...children];
  },
  setAttribute: (node, name, value) => {
    node.attrs[name] = value;
  },
};

function detail(overrides: Partial<PackageDetail> = {}): PackageDetail {
  return {
    path: 'github.com/pkg/sftp/v2',
    pageUrl: 'https://pkg.go.dev/github.com/pkg/sftp/v2',
    title: 'sftp',
    importPath: 'github.com/pkg/sftp/v2',
    chips: ['package', 'module'],
    version: { text: 'v2.0.0', url: 'https://pkg.go.dev/github.com/pkg/sftp/v2?tab=versions' },
    published: 'May 4, 2026',
    licenses: [{ text: 'BSD-2-Clause', url: 'https://pkg.go.dev/github.com/pkg/sftp/v2?tab=licenses' }],
    imports: { text: '20', url: 'https://pkg.go.dev/github.com/pkg/sftp/v2?tab=imports' },
    importedBy: { text: '1', url: 'https://pkg.go.dev/github.com/pkg/sftp/v2?tab=importedby' },
    checks: [
      { label: 'Valid go.mod file', ok: true },
      { label: 'Stable version', ok: false },
    ],
    repository: { text: 'github.com/pkg/sftp', url: 'https://github.com/pkg/sftp' },
    links: [{ text: 'Open Source Insights', url: 'https://deps.dev/go/x' }],
    ...overrides,
  };
}

const buildContext = {
  selected: 'linux',
  options: [
    { value: 'linux', label: 'linux/amd64' },
    { value: 'windows', label: 'windows/amd64' },
  ],
};

describe('renderHeader', () => {
  it('shows an Install button when the package is not installed', () => {
    const header = new FakeNode('header');
    const button = renderHeader(dom, header, detail(), false);
    expect(button.tag).toBe('button');
    expect(button.attrs).toMatchObject({ type: 'button', id: ACTION_ID });
    expect(button.text).toBe('Install');
    expect(header.findAll((n) => n.tag === 'button')).toEqual([button]);
  });

  it('shows an Uninstall button when the package is installed', () => {
    const header = new FakeNode('header');
    const button = renderHeader(dom, header, detail(), true);
    expect(button.text).toBe('Uninstall');
  });

  it('setInstalledButton flips the label', () => {
    const button = new FakeNode('button');
    setInstalledButton(dom, button, true);
    expect(button.text).toBe('Uninstall');
    setInstalledButton(dom, button, false);
    expect(button.text).toBe('Install');
  });

  it('renders the properties, chips and links', () => {
    const header = new FakeNode('header');
    renderHeader(dom, header, detail(), false);
    expect(header.find((n) => n.tag === 'h1')?.text).toBe('sftp');
    expect(header.findAll((n) => n.attrs.class === 'detail-chip').map((n) => n.text)).toEqual(['package', 'module']);
    expect(header.text).toContain('github.com/pkg/sftp/v2');
    expect(header.text).toContain('v2.0.0');
    expect(header.text).toContain('May 4, 2026');
    expect(header.text).toContain('BSD-2-Clause');
    expect(header.text).toContain('Repository: github.com/pkg/sftp');
    expect(header.text).toContain('Open Source Insights');
    const hrefs = header.findAll((n) => n.tag === 'a').map((n) => n.attrs.href);
    expect(hrefs).toContain('https://pkg.go.dev/github.com/pkg/sftp/v2?tab=versions');
    expect(hrefs).toContain('https://github.com/pkg/sftp');
    expect(hrefs[hrefs.length - 1]).toBe('https://pkg.go.dev/github.com/pkg/sftp/v2');
  });

  it('omits missing optional properties', () => {
    const header = new FakeNode('header');
    const minimal = detail({
      chips: [],
      licenses: [],
      checks: [],
      links: [],
    });
    const { version: _v, published: _p, imports: _i, importedBy: _b, repository: _r, ...rest } = minimal;
    renderHeader(dom, header, rest as PackageDetail, false);
    expect(header.text).not.toContain('Version');
    expect(header.text).not.toContain('Imports');
    expect(header.find((n) => n.attrs.class === 'detail-checks')).toBeUndefined();
    expect(header.findAll((n) => n.tag === 'a').map((n) => n.text)).toEqual(['View on pkg.go.dev']);
  });

  it('marks checks with text markers and hidden Yes/No text', () => {
    const header = new FakeNode('header');
    renderHeader(dom, header, detail(), false);
    const items = header.findAll((n) => n.tag === 'li' && (n.attrs.class ?? '').startsWith('detail-check'));
    expect(items).toHaveLength(2);
    expect(items[0]!.find((n) => n.attrs.class === 'detail-check-marker')?.text).toBe(CHECK_YES);
    expect(items[0]!.find((n) => n.attrs.class === 'visually-hidden')?.text).toBe(': Yes');
    expect(items[1]!.find((n) => n.attrs.class === 'detail-check-marker')?.text).toBe(CHECK_NO);
    expect(items[1]!.find((n) => n.attrs.class === 'visually-hidden')?.text).toBe(': No');
    expect(items[0]!.find((n) => n.attrs.class === 'detail-check-marker')?.attrs['aria-hidden']).toBe('true');
  });

  it('keeps hostile values as text nodes and sets link hrefs verbatim', () => {
    const header = new FakeNode('header');
    const hostile = '<img src=x onerror=1>';
    renderHeader(
      dom,
      header,
      detail({ title: hostile, chips: [hostile], published: hostile, version: { text: hostile, url: 'https://x.test/?a=1&b=2' } }),
      false,
    );
    expect(header.find((n) => n.tag === 'h1')?.children[0]?.tag).toBe('#text');
    expect(header.find((n) => n.tag === 'h1')?.text).toBe(hostile);
    expect(header.findAll((n) => n.tag === 'img')).toEqual([]);
    expect(header.findAll((n) => n.tag === 'a').some((n) => n.attrs.href === 'https://x.test/?a=1&b=2')).toBe(true);
  });
});

describe('renderGoosSelect', () => {
  it('renders a labelled select with the current option selected', () => {
    const container = new FakeNode('div');
    renderGoosSelect(dom, container, buildContext, 'windows', false);
    const select = container.find((n) => n.tag === 'select')!;
    expect(select.attrs.id).toBe(GOOS_SELECT_ID);
    expect(select.attrs.disabled).toBeUndefined();
    const options = select.children;
    expect(options.map((o) => [o.attrs.value, o.text])).toEqual([
      ['linux', 'linux/amd64'],
      ['windows', 'windows/amd64'],
    ]);
    expect(options.map((o) => 'selected' in o.attrs)).toEqual([false, true]);
    const label = container.find((n) => n.tag === 'label')!;
    expect(label.text).toBe('Rendered for');
    expect(label.attrs.for).toBe(GOOS_SELECT_ID);
  });

  it('disables the select when asked', () => {
    const container = new FakeNode('div');
    renderGoosSelect(dom, container, buildContext, 'linux', true);
    expect(container.find((n) => n.tag === 'select')?.attrs.disabled).toBe('');
  });

  it('renders nothing without a build context', () => {
    const container = new FakeNode('div');
    renderGoosSelect(dom, container, buildContext, 'linux', false);
    renderGoosSelect(dom, container, undefined, '', false);
    expect(container.children).toEqual([]);
  });
});

describe('renderStatus and renderRetry', () => {
  it('shows the placeholder when idle', () => {
    const status = new FakeNode('div');
    const error = new FakeNode('div');
    renderStatus(dom, status, error, { status: 'idle', path: '' });
    expect(status.text).toBe(IDLE_TEXT);
    expect(error.hidden).toBe(true);
  });

  it('shows the loading text and bar while loading', () => {
    const status = new FakeNode('div');
    const error = new FakeNode('div');
    renderStatus(dom, status, error, { status: 'loading', path: 'github.com/spf13/cobra' });
    expect(status.text).toBe('Loading github.com/spf13/cobra\u2026');
    expect(status.find((n) => n.attrs.class === 'detail-loading-bar')).toBeDefined();
  });

  it('shows the error with a Retry button on error', () => {
    const status = new FakeNode('div');
    const error = new FakeNode('div');
    renderStatus(dom, status, error, { status: 'loading', path: 'x' });
    renderStatus(dom, status, error, { status: 'error', path: 'x', error: 'Boom <b>' });
    expect(status.children).toEqual([]);
    expect(error.hidden).toBe(false);
    expect(error.find((n) => n.attrs.class === 'detail-error-text')?.text).toBe('Boom <b>');
    expect(error.find((n) => n.attrs.class === RETRY_CLASS)?.text).toBe('Retry');
  });

  it('clears the error region for ready', () => {
    const status = new FakeNode('div');
    const error = new FakeNode('div');
    renderRetry(dom, error, 'oops');
    renderStatus(dom, status, error, { status: 'ready', path: 'x' });
    expect(error.children).toEqual([]);
    expect(error.hidden).toBe(true);
  });
});
