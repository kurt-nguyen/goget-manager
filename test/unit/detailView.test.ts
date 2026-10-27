import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DetailViewModel } from '../../src/core/detailProtocol';
import type { PackageDetail } from '../../src/core/packageDetail';
import { README_COLLAPSE_HEIGHT, startDetailView } from '../../src/webview/detail';

type Handler = (event: any) => void;

let nextScrollHeight = 0;

class FakeEl {
  parent: FakeEl | undefined;
  children: FakeEl[] = [];
  attrs: Record<string, string> = {};
  handlers: Record<string, Handler> = {};
  hidden = false;
  value = '';
  text = '';
  htmlAssignments: string[] = [];
  scrollHeight = 0;
  scrollIntoView = vi.fn();
  constructor(readonly tag: string) {}

  get textContent(): string {
    return this.tag === '#text' ? this.text : this.children.map((c) => c.textContent).join('');
  }
  set textContent(value: string) {
    const node = new FakeEl('#text');
    node.text = value;
    this.replaceChildren(node);
  }
  set innerHTML(html: string) {
    this.htmlAssignments.push(html);
    this.children = [];
    this.scrollHeight = nextScrollHeight;
  }
  get id(): string {
    return this.attrs.id ?? '';
  }
  get classList() {
    const get = () => new Set((this.attrs.class ?? '').split(/\s+/).filter(Boolean));
    const set = (s: Set<string>) => {
      this.attrs.class = [...s].join(' ');
    };
    return {
      add: (c: string) => set(get().add(c)),
      contains: (c: string) => get().has(c),
      toggle: (c: string) => {
        const s = get();
        const has = s.has(c);
        if (has) s.delete(c);
        else s.add(c);
        set(s);
        return !has;
      },
    };
  }
  setAttribute(name: string, value: string): void {
    this.attrs[name] = value;
  }
  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }
  removeAttribute(name: string): void {
    delete this.attrs[name];
  }
  addEventListener(type: string, handler: Handler): void {
    this.handlers[type] = handler;
  }
  appendChild(node: FakeEl): FakeEl {
    node.parent = this;
    this.children.push(node);
    return node;
  }
  append(...nodes: FakeEl[]): void {
    nodes.forEach((n) => this.appendChild(n));
  }
  replaceChildren(...nodes: FakeEl[]): void {
    this.children = [];
    this.append(...nodes);
  }
  matches(selector: string): boolean {
    if (selector.startsWith('.')) return this.classList.contains(selector.slice(1));
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    return this.tag === selector;
  }
  closest(selector: string): FakeEl | null {
    for (let node: FakeEl | undefined = this; node; node = node.parent) {
      if (node.matches(selector)) return node;
    }
    return null;
  }
  find(pred: (node: FakeEl) => boolean): FakeEl | undefined {
    for (const child of this.children) {
      if (pred(child)) return child;
      const nested = child.find(pred);
      if (nested) return nested;
    }
    return undefined;
  }
  findAll(pred: (node: FakeEl) => boolean): FakeEl[] {
    return this.children.flatMap((c) => [...(pred(c) ? [c] : []), ...c.findAll(pred)]);
  }
}

function detail(overrides: Partial<PackageDetail> = {}): PackageDetail {
  return {
    path: 'github.com/pkg/sftp/v2',
    pageUrl: 'https://pkg.go.dev/github.com/pkg/sftp/v2',
    title: 'sftp',
    importPath: 'github.com/pkg/sftp/v2',
    chips: ['package'],
    version: { text: 'v2.0.0', url: 'https://pkg.go.dev/github.com/pkg/sftp/v2?tab=versions' },
    licenses: [],
    checks: [],
    links: [],
    readmeHtml: '<p>README</p>',
    docHtml: '<p>DOC</p>',
    buildContext: {
      selected: 'linux',
      options: [
        { value: 'linux', label: 'linux/amd64' },
        { value: 'windows', label: 'windows/amd64' },
      ],
    },
    ...overrides,
  };
}

function ready(d: PackageDetail, extra: Partial<DetailViewModel> = {}): { type: 'state'; state: DetailViewModel } {
  return {
    type: 'state',
    state: { status: 'ready', path: d.path, detail: d, goos: 'linux', installed: false, mainLoading: false, ...extra },
  };
}

describe('detail webview script', () => {
  let root: FakeEl;
  let status: FakeEl;
  let error: FakeEl;
  let header: FakeEl;
  let main: FakeEl;
  let windowHandlers: Record<string, Handler>;
  let postMessage: ReturnType<typeof vi.fn>;
  let byId: Record<string, FakeEl>;

  function send(data: unknown): void {
    windowHandlers.message!({ data });
  }
  function action(): FakeEl | undefined {
    return header.find((n) => n.id === 'detail-action');
  }
  function click(target: FakeEl): { preventDefault: ReturnType<typeof vi.fn> } {
    const event = { target, preventDefault: vi.fn() };
    root.handlers.click!(event);
    return event;
  }

  beforeEach(() => {
    nextScrollHeight = 0;
    root = new FakeEl('div');
    status = new FakeEl('div');
    error = new FakeEl('div');
    header = new FakeEl('header');
    main = new FakeEl('main');
    for (const [el, id] of [
      [root, 'detail-root'],
      [status, 'detail-status'],
      [error, 'detail-error'],
      [header, 'detail-header'],
      [main, 'detail-main'],
    ] as const) {
      el.setAttribute('id', id);
      if (el !== root) root.append(el);
    }
    byId = { 'detail-root': root, 'detail-status': status, 'detail-error': error, 'detail-header': header, 'detail-main': main };
    windowHandlers = {};
    postMessage = vi.fn();
    const doc = {
      getElementById: (id: string) => byId[id] ?? null,
      createElement: (tag: string) => new FakeEl(tag),
      createTextNode: (text: string) => {
        const node = new FakeEl('#text');
        node.text = text;
        return node;
      },
    };
    const win = {
      addEventListener: (type: string, handler: Handler) => {
        windowHandlers[type] = handler;
      },
    };
    startDetailView(doc as unknown as Document, win as unknown as Window, { postMessage });
    // Elements created later (scroll targets) are findable by id.
    doc.getElementById = (id: string) => byId[id] ?? main.find((n) => n.id === id) ?? null;
  });

  it('posts ready on load and shows the idle placeholder', () => {
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
    expect(status.textContent).toBe('Select a package from the Search view.');
  });

  it('shows the loading status for a loading state and clears old content', () => {
    send(ready(detail()));
    send({ type: 'state', state: { status: 'loading', path: 'github.com/spf13/cobra', installed: false, mainLoading: false } });
    expect(status.textContent).toBe('Loading github.com/spf13/cobra\u2026');
    expect(header.children).toEqual([]);
    expect(main.children).toEqual([]);
  });

  it('shows a page error with Retry, and Retry posts retry', () => {
    send({ type: 'state', state: { status: 'error', path: 'x', error: 'Nope', installed: false, mainLoading: false } });
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain('Nope');
    const retry = error.find((n) => n.tag === 'button')!;
    click(retry);
    expect(postMessage).toHaveBeenLastCalledWith({ type: 'retry' });
  });

  it('renders the header and main for a ready state', () => {
    send(ready(detail()));
    expect(header.find((n) => n.tag === 'h1')?.textContent).toBe('sftp');
    expect(action()?.textContent).toBe('Install');
    expect(main.find((n) => n.tag === 'h2' && n.textContent === 'README')).toBeDefined();
    expect(main.find((n) => n.tag === 'h2' && n.textContent === 'Documentation')).toBeDefined();
    expect(main.find((n) => n.id === 'detail-goos')).toBeDefined();
    expect(status.children).toEqual([]);
  });

  it('assigns host HTML only to the README and Documentation containers', () => {
    send(ready(detail({ title: '<img src=x onerror=1>' })));
    const assigned = [
      ...main.findAll((n) => n.htmlAssignments.length > 0),
      ...header.findAll((n) => n.htmlAssignments.length > 0),
    ];
    expect(assigned.map((n) => [n.attrs.class, n.htmlAssignments])).toEqual([
      ['detail-content detail-readme-content', ['<p>README</p>']],
      ['detail-content detail-doc-content', ['<p>DOC</p>']],
    ]);
    expect(header.find((n) => n.tag === 'h1')?.children[0]?.tag).toBe('#text');
  });

  it('source assigns the HTML property exactly twice', () => {
    const source = readFileSync(resolve(__dirname, '..', '..', 'src', 'webview', 'detail.ts'), 'utf8');
    expect(source.match(/\.innerHTML\s*=/g)).toHaveLength(2);
    expect(source).not.toMatch(/\bon(click|change|load|error)\s*=/);
  });

  it('shows Uninstall for installed state, and the installed message updates only the button', () => {
    const d = detail();
    send(ready(d, { installed: true }));
    expect(action()?.textContent).toBe('Uninstall');
    const headerChildren = [...header.children];
    const mainChildren = [...main.children];
    send({ type: 'installed', installed: false });
    expect(action()?.textContent).toBe('Install');
    expect(header.children).toEqual(headerChildren);
    expect(main.children).toEqual(mainChildren);
    send({ type: 'installed', installed: true });
    expect(action()?.textContent).toBe('Uninstall');
  });

  it('does not rebuild header or main when the same detail arrives again', () => {
    const d = detail();
    send(ready(d));
    const headerChildren = [...header.children];
    const mainChildren = [...main.children];
    send(ready(d, { mainLoading: true }));
    expect(header.children).toEqual(headerChildren);
    expect(main.children).toEqual(mainChildren);
  });

  it('posts install or uninstall according to state and nothing else', () => {
    send(ready(detail()));
    postMessage.mockClear();
    click(action()!);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'install' });
    send({ type: 'installed', installed: true });
    postMessage.mockClear();
    click(action()!);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith({ type: 'uninstall' });
  });

  it('omits the GOOS select when the page has no build context', () => {
    send(ready(detail({ buildContext: undefined })));
    expect(main.find((n) => n.tag === 'select')).toBeUndefined();
  });

  it('posts changeGoos on select change, and shows main loading with a disabled select', () => {
    const d = detail();
    send(ready(d));
    const select = main.find((n) => n.id === 'detail-goos')!;
    select.value = 'windows';
    postMessage.mockClear();
    root.handlers.change!({ target: select });
    expect(postMessage).toHaveBeenCalledWith({ type: 'changeGoos', goos: 'windows' });

    send(ready(d, { mainLoading: true }));
    expect(main.attrs.class).toContain('is-loading');
    expect(main.attrs['aria-busy']).toBe('true');
    const loadingSelect = main.find((n) => n.id === 'detail-goos')!;
    expect(loadingSelect.attrs.disabled).toBe('');
    expect(loadingSelect.children.map((o) => 'selected' in o.attrs)).toEqual([false, true]);
    expect(main.find((n) => n.attrs.class === 'detail-loading')?.hidden).toBe(false);
  });

  it('shows an inline error with Retry and reverts the select to the model GOOS', () => {
    const d = detail();
    send(ready(d));
    const select = main.find((n) => n.id === 'detail-goos')!;
    select.value = 'windows';
    root.handlers.change!({ target: select });
    send(ready(d, { mainLoading: true }));
    send(ready(d, { error: 'Timed out', goos: 'linux' }));
    expect(main.getAttribute('aria-busy')).toBeNull();
    expect(main.attrs.class).not.toContain('is-loading');
    const banner = main.find((n) => n.id === '' && (n.attrs.class ?? '').includes('detail-main-error'))!;
    expect(banner.hidden).toBe(false);
    expect(banner.textContent).toContain('Timed out');
    const restored = main.find((n) => n.id === 'detail-goos')!;
    expect(restored.attrs.disabled).toBeUndefined();
    expect(restored.children.map((o) => 'selected' in o.attrs)).toEqual([true, false]);
    postMessage.mockClear();
    click(banner.find((n) => n.tag === 'button')!);
    expect(postMessage).toHaveBeenCalledWith({ type: 'retry' });
  });

  it('ignores change events from other elements', () => {
    send(ready(detail()));
    postMessage.mockClear();
    const other = new FakeEl('select');
    other.value = 'x';
    root.handlers.change!({ target: other });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('opens external anchors through openLink and never navigates', () => {
    send(ready(detail()));
    postMessage.mockClear();
    const anchor = header.find((n) => n.tag === 'a')!;
    const event = click(anchor);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledWith({ type: 'openLink', url: anchor.attrs.href });
  });

  it('scrolls to the decoded id for #pd-* fragment links and posts nothing', () => {
    send(ready(detail()));
    postMessage.mockClear();
    const target = new FakeEl('h3');
    target.setAttribute('id', 'pd-pkg:overview');
    main.append(target);
    const link = new FakeEl('a');
    link.setAttribute('href', '#pd-pkg%3Aoverview');
    main.append(link);
    const event = click(link);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(target.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('ignores malformed fragment escapes and anchors without href', () => {
    send(ready(detail()));
    postMessage.mockClear();
    const bad = new FakeEl('a');
    bad.setAttribute('href', '#pd-%E0%A4%A');
    main.append(bad);
    const plain = new FakeEl('a');
    main.append(plain);
    expect(click(bad).preventDefault).toHaveBeenCalled();
    expect(click(plain).preventDefault).toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('collapses a tall README with an Expand toggle and expands on click', () => {
    nextScrollHeight = README_COLLAPSE_HEIGHT + 1;
    send(ready(detail()));
    const content = main.find((n) => (n.attrs.class ?? '').includes('detail-readme-content'))!;
    const toggle = main.find((n) => n.attrs.class === 'detail-toggle')!;
    expect(content.classList.contains('is-collapsed')).toBe(true);
    expect(toggle.hidden).toBe(false);
    expect(toggle.attrs['aria-expanded']).toBe('false');
    expect(toggle.textContent).toBe('Expand');
    toggle.handlers.click!({});
    expect(content.classList.contains('is-collapsed')).toBe(false);
    expect(toggle.attrs['aria-expanded']).toBe('true');
    expect(toggle.textContent).toBe('Collapse');
  });

  it('shows no toggle for a short README', () => {
    nextScrollHeight = 100;
    send(ready(detail()));
    const content = main.find((n) => (n.attrs.class ?? '').includes('detail-readme-content'))!;
    const toggle = main.find((n) => n.attrs.class === 'detail-toggle')!;
    expect(content.classList.contains('is-collapsed')).toBe(false);
    expect(toggle.hidden).toBe(true);
  });

  it('omits the README section when there is no README', () => {
    send(ready(detail({ readmeHtml: undefined })));
    expect(main.find((n) => n.textContent === 'README')).toBeUndefined();
    expect(main.find((n) => n.textContent === 'Documentation')).toBeDefined();
  });

  it('ignores malformed messages', () => {
    send(null);
    send({ type: 'other' });
    send({ type: 'state', state: { status: 'ready', path: 'x', installed: false, mainLoading: false } });
    send({ type: 'state', state: { status: 'bogus', path: 'x', installed: false, mainLoading: false } });
    send({ type: 'installed', installed: 'yes' });
    expect(header.children).toEqual([]);
    expect(status.textContent).toBe('Select a package from the Search view.');
  });
});
