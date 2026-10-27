import { tokenizeHtml } from './htmlTokens';

export interface PackageResult {
  readonly path: string;
  readonly name: string;
  readonly synopsis?: string;
  readonly version?: string;
  readonly published?: string;
  readonly importedBy?: string;
}

/** Every pkg.go.dev markup hook the parser relies on, taken from `sample-pages/SearchResults.html`. */
const SELECTORS = {
  entry: { tag: 'div', className: 'SearchSnippet' },
  titleLink: { tag: 'a', attr: 'data-test-id', value: 'snippet-title' },
  titleFallback: { container: 'h2', tag: 'a' },
  path: { tag: 'span', className: 'SearchSnippet-header-path' },
  synopsis: { tag: 'p', className: 'SearchSnippet-synopsis' },
  infoLabel: { tag: 'div', className: 'SearchSnippet-infoLabel' },
  importedByLink: {
    tag: 'a',
    hrefContains: 'tab=importedby',
    ariaLabelAttr: 'aria-label',
    ariaLabel: 'Go to Imported By',
    valueTag: 'strong',
  },
  published: { attr: 'data-test-id', value: 'snippet-published' },
  license: { attr: 'data-test-id', value: 'snippet-license' },
  version: { tag: 'strong' },
} as const;

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

// Capture fields. `nameP`/`pathP` come from the `data-test-id` title link, `nameF`/`pathF` from the `h2 > a` fallback.
const NAME_P = 1;
const NAME_F = 2;
const PATH_P = 4;
const PATH_F = 8;
const SYNOPSIS = 16;
const VERSION = 32;
const IMPORTED_BY = 64;
const PUBLISHED = 128;
const NAME_FIELDS = NAME_P | NAME_F;

// Roles an open element can play; used to keep the per-entry counters in step with the stack.
const ROLE_ENTRY = 1;
const ROLE_H2 = 2;
const ROLE_TITLE_P = 4;
const ROLE_TITLE_F = 8;
const ROLE_PATH = 16;
const ROLE_INFO = 32;
const ROLE_IMPORTED = 64;
const ROLE_PUBLISHED = 128;
const ROLE_LICENSE = 256;

interface Capture {
  readonly field: number;
  text: string;
}

interface Entry {
  done: boolean;
  /** Bit set of fields whose capture has been started (each field is captured at most once). */
  started: number;
  readonly values: Map<number, string>;
  readonly active: Capture[];
  h2Seen: boolean;
  infoSeen: boolean;
  h2Open: number;
  titleP: number;
  titleF: number;
  pathOpen: number;
  infoOpen: number;
  importedOpen: number;
  publishedOpen: number;
  licenseOpen: number;
}

interface Frame {
  readonly name: string;
  readonly entry: Entry | undefined;
  mask: number;
  captures: Capture[] | undefined;
}

function newEntry(): Entry {
  return {
    done: false,
    started: 0,
    values: new Map<number, string>(),
    active: [],
    h2Seen: false,
    infoSeen: false,
    h2Open: 0,
    titleP: 0,
    titleF: 0,
    pathOpen: 0,
    infoOpen: 0,
    importedOpen: 0,
    publishedOpen: 0,
    licenseOpen: 0,
  };
}

function hasClass(attrs: ReadonlyMap<string, string>, className: string): boolean {
  const value = attrs.get('class');
  if (value === undefined) {
    return false;
  }
  return value === className || value.split(/\s+/u).includes(className);
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

function normalizePath(text: string): string {
  let value = normalize(text);
  if (value.startsWith('(')) {
    value = value.slice(1);
  }
  if (value.endsWith(')')) {
    value = value.slice(0, -1);
  }
  return value.trim();
}

function valueOf(entry: Entry, field: number): string | undefined {
  return entry.values.get(field);
}

function toResult(entry: Entry): PackageResult | undefined {
  const primary = valueOf(entry, NAME_P) !== undefined;
  const rawName = primary ? valueOf(entry, NAME_P) : valueOf(entry, NAME_F);
  const rawPath = primary ? valueOf(entry, PATH_P) : valueOf(entry, PATH_F);
  if (rawName === undefined || rawPath === undefined) {
    return undefined;
  }
  const name = normalize(rawName);
  const path = normalizePath(rawPath);
  if (name === '' || path === '' || /\s/u.test(path)) {
    return undefined;
  }
  const result: {
    path: string;
    name: string;
    synopsis?: string;
    version?: string;
    published?: string;
    importedBy?: string;
  } = { path, name };
  const optional: [keyof typeof result, number][] = [
    ['synopsis', SYNOPSIS],
    ['version', VERSION],
    ['published', PUBLISHED],
    ['importedBy', IMPORTED_BY],
  ];
  for (const [key, field] of optional) {
    const raw = valueOf(entry, field);
    if (raw !== undefined) {
      const value = normalize(raw);
      if (value !== '') {
        result[key] = value;
      }
    }
  }
  return result;
}

function extract(html: string, results: PackageResult[]): void {
  const stack: Frame[] = [];
  const openCounts = new Map<string, number>();
  let current: Entry | undefined;

  const finalize = (entry: Entry): void => {
    entry.done = true;
    if (current === entry) {
      current = undefined;
    }
    const result = toResult(entry);
    if (result !== undefined) {
      results.push(result);
    }
  };

  const startCapture = (frame: Frame, entry: Entry, field: number): void => {
    entry.started |= field;
    const capture: Capture = { field, text: '' };
    (frame.captures ??= []).push(capture);
    entry.active.push(capture);
  };

  const closeFrame = (frame: Frame): void => {
    const entry = frame.entry;
    if (entry === undefined) {
      return;
    }
    const mask = frame.mask;
    if (mask & ROLE_H2) entry.h2Open--;
    if (mask & ROLE_TITLE_P) entry.titleP--;
    if (mask & ROLE_TITLE_F) entry.titleF--;
    if (mask & ROLE_PATH) entry.pathOpen--;
    if (mask & ROLE_INFO) entry.infoOpen--;
    if (mask & ROLE_IMPORTED) entry.importedOpen--;
    if (mask & ROLE_PUBLISHED) entry.publishedOpen--;
    if (mask & ROLE_LICENSE) entry.licenseOpen--;

    if (frame.captures !== undefined && !entry.done) {
      for (const capture of frame.captures) {
        const index = entry.active.indexOf(capture);
        if (index !== -1) {
          entry.active.splice(index, 1);
        }
        if (!entry.values.has(capture.field)) {
          entry.values.set(capture.field, capture.text);
        }
      }
    }
    if (mask & ROLE_ENTRY && !entry.done) {
      finalize(entry);
    }
  };

  for (const token of tokenizeHtml(html)) {
    if (token.kind === 'text') {
      if (current !== undefined && current.active.length > 0) {
        const paused = current.pathOpen > 0;
        for (const capture of current.active) {
          if (paused && (capture.field & NAME_FIELDS) !== 0) {
            continue;
          }
          capture.text += token.text;
        }
      }
      continue;
    }

    if (token.kind === 'end') {
      const name = token.name;
      if (!openCounts.get(name)) {
        continue;
      }
      for (;;) {
        const frame = stack.pop() as Frame;
        openCounts.set(frame.name, (openCounts.get(frame.name) as number) - 1);
        closeFrame(frame);
        if (frame.name === name) {
          break;
        }
      }
      continue;
    }

    if (token.selfClosing || VOID_ELEMENTS.has(token.name)) {
      continue;
    }

    const name = token.name;
    const attrs = token.attrs;

    if (name === SELECTORS.entry.tag && hasClass(attrs, SELECTORS.entry.className)) {
      if (current !== undefined) {
        finalize(current);
      }
      current = newEntry();
      stack.push({ name, entry: current, mask: ROLE_ENTRY, captures: undefined });
      openCounts.set(name, (openCounts.get(name) ?? 0) + 1);
      continue;
    }

    const entry = current;
    const frame: Frame = { name, entry, mask: 0, captures: undefined };
    stack.push(frame);
    openCounts.set(name, (openCounts.get(name) ?? 0) + 1);
    if (entry === undefined) {
      continue;
    }

    let mask = 0;
    const testId = attrs.get(SELECTORS.published.attr);

    if (testId !== undefined) {
      if (testId === SELECTORS.published.value) {
        entry.publishedOpen++;
        mask |= ROLE_PUBLISHED;
        if ((entry.started & PUBLISHED) === 0) {
          startCapture(frame, entry, PUBLISHED);
        }
      } else if (testId === SELECTORS.license.value) {
        entry.licenseOpen++;
        mask |= ROLE_LICENSE;
      }
    }
    if (name === SELECTORS.titleFallback.container && !entry.h2Seen) {
      entry.h2Seen = true;
      entry.h2Open++;
      mask |= ROLE_H2;
    }

    if (name === SELECTORS.titleLink.tag) {
      if (
        testId === SELECTORS.titleLink.value &&
        (entry.started & NAME_P) === 0
      ) {
        entry.titleP++;
        mask |= ROLE_TITLE_P;
        startCapture(frame, entry, NAME_P);
      }
      if (entry.h2Open > 0 && (entry.started & NAME_F) === 0) {
        entry.titleF++;
        mask |= ROLE_TITLE_F;
        startCapture(frame, entry, NAME_F);
      }
      if (
        entry.infoOpen > 0 &&
        ((attrs.get('href') ?? '').toLowerCase().includes(SELECTORS.importedByLink.hrefContains) ||
          attrs.get(SELECTORS.importedByLink.ariaLabelAttr) === SELECTORS.importedByLink.ariaLabel)
      ) {
        entry.importedOpen++;
        mask |= ROLE_IMPORTED;
      }
    } else if (name === SELECTORS.path.tag) {
      if (hasClass(attrs, SELECTORS.path.className) && (entry.titleP > 0 || entry.titleF > 0)) {
        entry.pathOpen++;
        mask |= ROLE_PATH;
        if (entry.titleP > 0 && (entry.started & PATH_P) === 0) {
          startCapture(frame, entry, PATH_P);
        }
        if (entry.titleF > 0 && (entry.started & PATH_F) === 0) {
          startCapture(frame, entry, PATH_F);
        }
      }
    } else if (name === SELECTORS.synopsis.tag) {
      if (hasClass(attrs, SELECTORS.synopsis.className) && (entry.started & SYNOPSIS) === 0) {
        startCapture(frame, entry, SYNOPSIS);
      }
    } else if (name === SELECTORS.infoLabel.tag) {
      if (hasClass(attrs, SELECTORS.infoLabel.className) && !entry.infoSeen) {
        entry.infoSeen = true;
        entry.infoOpen++;
        mask |= ROLE_INFO;
      }
    } else if (name === SELECTORS.version.tag) {
      if (entry.importedOpen > 0) {
        if ((entry.started & IMPORTED_BY) === 0) {
          startCapture(frame, entry, IMPORTED_BY);
        }
      } else if (
        entry.infoOpen > 0 &&
        entry.publishedOpen === 0 &&
        entry.licenseOpen === 0 &&
        (entry.started & VERSION) === 0
      ) {
        startCapture(frame, entry, VERSION);
      }
    }


    frame.mask = mask;
  }

  if (current !== undefined) {
    // Captures still open here are discarded: cut-off text is never reported.
    finalize(current);
  }
}

/** Never throws. Returns entries in page order, duplicates kept. */
export function parseSearchResults(html: string): PackageResult[] {
  const results: PackageResult[] = [];
  if (typeof html !== 'string') {
    return results;
  }
  try {
    extract(html, results);
  } catch {
    // Keep whatever was extracted before the failure.
  }
  return results;
}
