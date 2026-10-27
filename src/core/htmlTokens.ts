export type HtmlToken =
  | {
      readonly kind: 'start';
      readonly name: string;
      readonly attrs: ReadonlyMap<string, string>;
      readonly selfClosing: boolean;
    }
  | { readonly kind: 'end'; readonly name: string }
  | { readonly kind: 'text'; readonly text: string }; // character references already decoded

const LT = 0x3c;
const GT = 0x3e;
const SLASH = 0x2f;
const BANG = 0x21;
const QUESTION = 0x3f;
const EQUALS = 0x3d;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;

const RAW_TEXT_ELEMENTS: ReadonlySet<string> = new Set(['script', 'style', 'textarea', 'title']);

const REPLACEMENT_CHARACTER = '\uFFFD';

const CHARACTER_REFERENCE = /&(?:#[xX]([0-9a-fA-F]+)|#([0-9]+)|(amp|lt|gt|quot|apos|nbsp));/g;

const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isSpace(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d || code === 0x0c;
}

function fromCodePoint(codePoint: number): string {
  if (
    !Number.isFinite(codePoint) ||
    codePoint < 1 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return REPLACEMENT_CHARACTER;
  }
  return String.fromCodePoint(codePoint);
}

/**
 * Decodes `&amp; &lt; &gt; &quot; &apos; &nbsp;`, `&#NNN;` and `&#xHH;`.
 *
 * Code points that are zero, above U+10FFFF, or surrogates become U+FFFD.
 * Unknown named references (and references without `;`) stay literal.
 * Decoding is a single pass, so `&amp;lt;` becomes `&lt;`.
 */
export function decodeCharacterReferences(text: string): string {
  if (text.indexOf('&') === -1) {
    return text;
  }
  return text.replace(
    CHARACTER_REFERENCE,
    (_match, hex: string | undefined, dec: string | undefined, named: string | undefined) => {
      if (named !== undefined) {
        return NAMED_REFERENCES[named] as string;
      }
      if (hex !== undefined) {
        return fromCodePoint(parseInt(hex, 16));
      }
      return fromCodePoint(parseInt(dec as string, 10));
    },
  );
}

interface Scanned {
  readonly token: HtmlToken | undefined;
  /** Index just after the construct. */
  readonly end: number;
}

/** Scans an end tag starting at `lt` (`</`). Returns undefined when unterminated. */
function scanEndTag(html: string, lt: number): Scanned | undefined {
  const close = html.indexOf('>', lt + 2);
  if (close === -1) {
    return undefined;
  }
  let i = lt + 2;
  while (i < close) {
    const code = html.charCodeAt(i);
    if (isSpace(code) || code === SLASH) {
      break;
    }
    i++;
  }
  const name = html.slice(lt + 2, i).toLowerCase();
  // `</>` or `</ ...>` carries no name; it is skipped like a bogus comment.
  return { token: name === '' ? undefined : { kind: 'end', name }, end: close + 1 };
}

/** Scans a start tag starting at `lt` (`<` + ASCII letter). Returns undefined when unterminated. */
function scanStartTag(html: string, lt: number): Scanned | undefined {
  const len = html.length;
  let i = lt + 1;
  while (i < len) {
    const code = html.charCodeAt(i);
    if (isSpace(code) || code === SLASH || code === GT) {
      break;
    }
    i++;
  }
  const name = html.slice(lt + 1, i).toLowerCase();
  const attrs = new Map<string, string>();
  let selfClosing = false;

  for (;;) {
    while (i < len && isSpace(html.charCodeAt(i))) {
      i++;
    }
    if (i >= len) {
      return undefined;
    }
    const code = html.charCodeAt(i);
    if (code === GT) {
      i++;
      break;
    }
    if (code === SLASH) {
      if (i + 1 >= len) {
        return undefined;
      }
      if (html.charCodeAt(i + 1) === GT) {
        selfClosing = true;
        i += 2;
        break;
      }
      i++;
      continue;
    }

    // Attribute name: at least one character, so a leading `=` cannot stall the loop.
    const nameStart = i;
    i++;
    while (i < len) {
      const c = html.charCodeAt(i);
      if (isSpace(c) || c === EQUALS || c === SLASH || c === GT) {
        break;
      }
      i++;
    }
    const attrName = html.slice(nameStart, i).toLowerCase();

    let j = i;
    while (j < len && isSpace(html.charCodeAt(j))) {
      j++;
    }
    let value = '';
    if (j < len && html.charCodeAt(j) === EQUALS) {
      j++;
      while (j < len && isSpace(html.charCodeAt(j))) {
        j++;
      }
      if (j >= len) {
        return undefined;
      }
      const q = html.charCodeAt(j);
      if (q === DOUBLE_QUOTE || q === SINGLE_QUOTE) {
        const closeQuote = html.indexOf(q === DOUBLE_QUOTE ? '"' : "'", j + 1);
        if (closeQuote === -1) {
          return undefined;
        }
        value = decodeCharacterReferences(html.slice(j + 1, closeQuote));
        i = closeQuote + 1;
      } else {
        const valueStart = j;
        while (j < len) {
          const c = html.charCodeAt(j);
          if (isSpace(c) || c === GT) {
            break;
          }
          j++;
        }
        value = decodeCharacterReferences(html.slice(valueStart, j));
        i = j;
      }
    }
    if (!attrs.has(attrName)) {
      attrs.set(attrName, value);
    }
  }

  return { token: { kind: 'start', name, attrs, selfClosing }, end: i };
}

function* scan(html: string): Generator<HtmlToken, void, undefined> {
  const len = html.length;
  let pos = 0;
  let textStart = 0;

  while (pos < len) {
    const lt = html.indexOf('<', pos);
    if (lt === -1) {
      break;
    }
    const next = lt + 1 < len ? html.charCodeAt(lt + 1) : -1;
    if (next !== SLASH && next !== BANG && next !== QUESTION && !isAsciiLetter(next)) {
      pos = lt + 1; // literal `<`
      continue;
    }

    if (lt > textStart) {
      yield { kind: 'text', text: decodeCharacterReferences(html.slice(textStart, lt)) };
    }

    let end: number;
    if (next === BANG || next === QUESTION) {
      const terminator = next === BANG && html.startsWith('<!--', lt) ? '-->' : '>';
      const from = terminator === '-->' ? lt + 4 : lt + 2;
      const close = html.indexOf(terminator, from);
      if (close === -1) {
        return;
      }
      end = close + terminator.length;
    } else if (next === SLASH) {
      const scanned = scanEndTag(html, lt);
      if (scanned === undefined) {
        return;
      }
      if (scanned.token !== undefined) {
        yield scanned.token;
      }
      end = scanned.end;
    } else {
      const scanned = scanStartTag(html, lt);
      if (scanned === undefined || scanned.token === undefined) {
        return;
      }
      yield scanned.token;
      end = scanned.end;

      const token = scanned.token;
      if (token.kind === 'start' && !token.selfClosing && RAW_TEXT_ELEMENTS.has(token.name)) {
        const endTag = new RegExp(`</${token.name}(?=[\\t\\n\\f\\r />])`, 'gi');
        endTag.lastIndex = end;
        const match = endTag.exec(html);
        if (match === null) {
          return; // raw text runs to end of input and is never captured
        }
        end = match.index;
      }
    }

    pos = end;
    textStart = end;
  }

  if (textStart < len) {
    yield { kind: 'text', text: decodeCharacterReferences(html.slice(textStart)) };
  }
}

/**
 * Lazily yields tokens in a single `indexOf`-driven pass. Never throws.
 * An unterminated tag, comment, or quoted attribute value is dropped and
 * ends tokenization.
 */
export function tokenizeHtml(html: string): Iterable<HtmlToken> {
  return typeof html === 'string' ? scan(html) : [];
}
