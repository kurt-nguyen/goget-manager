import { tokenizeHtml } from './htmlTokens';

export interface HtmlElement {
  readonly kind: 'element';
  readonly name: string;
  readonly attrs: ReadonlyMap<string, string>;
  readonly children: HtmlNode[];
}

export interface HtmlText {
  readonly kind: 'text';
  readonly text: string;
}

export type HtmlNode = HtmlElement | HtmlText;

/** Maximum number of open elements (the synthetic root included). Deeper elements attach to the deepest open one. */
export const MAX_TREE_DEPTH = 256;

const ROOT_NAME = '#root';

const VOID_ELEMENTS: ReadonlySet<string> = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);

function newElement(name: string, attrs: ReadonlyMap<string, string>): HtmlElement {
  return { kind: 'element', name, attrs, children: [] };
}

/**
 * Builds a lenient element tree from `tokenizeHtml`. Never throws: on any
 * failure the tree built so far is returned.
 */
export function parseHtmlTree(html: string): HtmlElement {
  const root = newElement(ROOT_NAME, new Map());
  try {
    build(html, root);
  } catch {
    // Keep whatever was built before the failure.
  }
  return root;
}

function build(html: string, root: HtmlElement): void {
  const stack: HtmlElement[] = [root];
  // Elements that were not pushed because of the depth cap, counted per name so their end tags are ignored.
  const overflow = new Map<string, number>();

  for (const token of tokenizeHtml(html)) {
    const top = stack[stack.length - 1] as HtmlElement;

    if (token.kind === 'text') {
      top.children.push({ kind: 'text', text: token.text });
      continue;
    }

    if (token.kind === 'start') {
      const element = newElement(token.name, token.attrs);
      top.children.push(element);
      if (token.selfClosing || VOID_ELEMENTS.has(token.name)) {
        continue;
      }
      if (stack.length >= MAX_TREE_DEPTH) {
        overflow.set(token.name, (overflow.get(token.name) ?? 0) + 1);
      } else {
        stack.push(element);
      }
      continue;
    }

    const pending = overflow.get(token.name);
    if (pending !== undefined && pending > 0) {
      overflow.set(token.name, pending - 1);
      continue;
    }
    for (let i = stack.length - 1; i >= 1; i--) {
      if ((stack[i] as HtmlElement).name === token.name) {
        stack.length = i;
        break;
      }
    }
  }
}

function pushChildrenReversed(stack: HtmlNode[], node: HtmlElement): void {
  for (let i = node.children.length - 1; i >= 0; i--) {
    stack.push(node.children[i] as HtmlNode);
  }
}

/** First descendant element (document order, `node` itself excluded) matching `pred`. */
export function findFirst(node: HtmlElement, pred: (el: HtmlElement) => boolean): HtmlElement | undefined {
  const stack: HtmlNode[] = [];
  pushChildrenReversed(stack, node);
  while (stack.length > 0) {
    const current = stack.pop() as HtmlNode;
    if (current.kind !== 'element') {
      continue;
    }
    if (pred(current)) {
      return current;
    }
    pushChildrenReversed(stack, current);
  }
  return undefined;
}

/** All descendant elements (document order, `node` itself excluded) matching `pred`. */
export function findAll(node: HtmlElement, pred: (el: HtmlElement) => boolean): HtmlElement[] {
  const found: HtmlElement[] = [];
  const stack: HtmlNode[] = [];
  pushChildrenReversed(stack, node);
  while (stack.length > 0) {
    const current = stack.pop() as HtmlNode;
    if (current.kind !== 'element') {
      continue;
    }
    if (pred(current)) {
      found.push(current);
    }
    pushChildrenReversed(stack, current);
  }
  return found;
}

/** Concatenated descendant text with whitespace collapsed and trimmed. */
export function textContent(node: HtmlNode): string {
  if (node.kind === 'text') {
    return node.text.replace(/\s+/gu, ' ').trim();
  }
  let text = '';
  const stack: HtmlNode[] = [];
  pushChildrenReversed(stack, node);
  while (stack.length > 0) {
    const current = stack.pop() as HtmlNode;
    if (current.kind === 'text') {
      text += current.text;
    } else {
      pushChildrenReversed(stack, current);
    }
  }
  return text.replace(/\s+/gu, ' ').trim();
}

export function hasClass(el: HtmlElement, cls: string): boolean {
  const value = el.attrs.get('class');
  if (value === undefined) {
    return false;
  }
  return value === cls || value.split(/\s+/u).includes(cls);
}

export function attr(el: HtmlElement, name: string): string | undefined {
  return el.attrs.get(name);
}
