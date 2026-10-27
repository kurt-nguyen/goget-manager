/**
 * Shared fast-check generators for the search-packages properties.
 *
 * Main exports:
 *  - `queryArb`, `boxTextArb`, `whitespaceArb`: Search_Query and raw Search_Box text generators.
 *  - `validEntrySpecArb`, `invalidEntrySpecArb`, `anyEntrySpecArb`: what one result entry *means*
 *    (name, path, and the optional synopsis/version/published/importedBy as raw text).
 *  - `entryNoiseArb`, `entryModelArb`, `pageModelArb`: presentation noise stored as data (so it
 *    shrinks and renders deterministically) and entries/pages built from specs plus noise.
 *  - `renderEntry`, `renderPage`: render a model as markup shaped like `sample-pages/SearchResults.html`.
 *  - `expectedResult`, `expectedResults`, `isValidEntrySpec`, `normalizeText`: the spec -> expected
 *    `PackageResult` mapping (normalized whitespace, optional fields omitted when empty, invalid
 *    entries dropped).
 *
 * Spec semantics (the contract between renderer and expectation):
 *  - `name`: raw text shown as the entry title. Expected: whitespace runs collapsed and trimmed;
 *    invalid when `undefined` or blank after that.
 *  - `path`: raw text placed between the parentheses of the `SearchSnippet-header-path` span.
 *    Expected: trimmed; invalid when `undefined` (no path span), blank, or containing whitespace.
 *  - optional fields: `undefined` = element absent; otherwise raw text placed in the element.
 *    Expected: whitespace-normalized; omitted when that leaves nothing.
 *
 * Renderer facts (see src/core/resultsParser.ts): every value is HTML-escaped (`&`, `<`, `>` always,
 * quotes in attributes and by style in text) through named, decimal, hexadecimal, or mixed character
 * references, so `decodeCharacterReferences` recovers it exactly. Noise only adds whitespace, comments,
 * raw-text blocks, extra attributes/classes, inline wrapper tags *inside* values (never adding
 * whitespace), and the "Other major versions" / "Other packages in module" blocks.
 */
import * as fc from 'fast-check';
import type { PackageResult } from '../../src/core/resultsParser';
import {
  SearchController,
  type OutputLike,
  type SearchClient,
  type SearchControllerDeps,
  type SearchResponse,
} from '../../src/core/searchController';
import { FakeTimers } from './fakeTimers';

// ---------------------------------------------------------------------------
// Search_Query and Search_Box text
// ---------------------------------------------------------------------------

// Characters that are most likely to break URL construction.
const specialUnit = fc.constantFrom(...'&=#+%?/ !\'()*;:@$,"<>\\'.split(''));
const asciiUnit = fc.integer({ min: 0x20, max: 0x7e }).map((cp) => String.fromCharCode(cp));
// Non-ASCII BMP code points, excluding surrogates (well-formed strings only).
const nonAsciiUnit = fc
  .integer({ min: 0x80, max: 0xffff })
  .filter((cp) => cp < 0xd800 || cp > 0xdfff)
  .map((cp) => String.fromCodePoint(cp));
const astralUnit = fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp));

/** Well-formed queries of 1-256 code points with no leading or trailing white space. */
export const queryArb: fc.Arbitrary<string> = fc
  .string({
    unit: fc.oneof(
      { weight: 4, arbitrary: specialUnit },
      { weight: 3, arbitrary: asciiUnit },
      { weight: 2, arbitrary: nonAsciiUnit },
      { weight: 2, arbitrary: astralUnit },
    ),
    minLength: 1,
    maxLength: 256,
  })
  .filter((s) => s.trim() === s && s.length > 0);

const WHITESPACE_CHARS = [' ', ' ', '\t', '\n', '\r', '\u00a0', '\u2003', '\u3000', '\ufeff', '\u2028'];

/** Possibly empty run of white space (as `trim()` and `/\s/u` see it). */
export const whitespaceArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { maxLength: 6 })
  .map((chars) => chars.join(''));

/** Non-empty run of white space. */
const whitespaceRunArb: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...WHITESPACE_CHARS), { minLength: 1, maxLength: 5 })
  .map((chars) => chars.join(''));

/**
 * Raw Search_Box text: padded queries, empty or whitespace-only text, and text longer than
 * 256 code points. Always well formed (no lone surrogates).
 */
export const boxTextArb: fc.Arbitrary<string> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.tuple(whitespaceArb, queryArb, whitespaceArb).map(([a, q, b]) => `${a}${q}${b}`),
  },
  { weight: 1, arbitrary: whitespaceArb },
  {
    weight: 1,
    arbitrary: fc
      .string({ unit: fc.oneof(asciiUnit, nonAsciiUnit, astralUnit), minLength: 250, maxLength: 320 })
      .map((s) => s),
  },
);

// ---------------------------------------------------------------------------
// Entry specs
// ---------------------------------------------------------------------------

export interface EntrySpec {
  /** Entry title text; `undefined` = no title text. */
  readonly name: string | undefined;
  /** Text between the parentheses of the path span; `undefined` = no path span. */
  readonly path: string | undefined;
  readonly synopsis: string | undefined;
  readonly version: string | undefined;
  readonly published: string | undefined;
  readonly importedBy: string | undefined;
}

const OPTIONAL_KEYS = ['synopsis', 'version', 'published', 'importedBy'] as const;

/** Non-whitespace characters: ASCII punctuation (including `< > & " '`), non-ASCII, and astral. */
const textUnit = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 0x21, max: 0x7e }).map((cp) => String.fromCharCode(cp)) },
  { weight: 2, arbitrary: nonAsciiUnit.filter((c) => !/\s/u.test(c)) },
  { weight: 1, arbitrary: astralUnit },
);

const wordArb = fc.string({ unit: textUnit, minLength: 1, maxLength: 8 });

/** Fragments that stress escaping and label stripping. */
const specialFragmentArb = fc.constantFrom(
  '<',
  '>',
  '&',
  '"',
  "'",
  '&amp;',
  '&lt;',
  '&#39;',
  '&#x26;',
  '</b>',
  '<script>',
  '<!--',
  '-->',
  'Imported by ',
  'published on ',
  ' | ',
  '<div class="SearchSnippet">',
);

/** Any text, possibly empty or white-space-only. */
const textArb: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      { weight: 5, arbitrary: wordArb },
      { weight: 2, arbitrary: specialFragmentArb },
      { weight: 3, arbitrary: whitespaceRunArb },
    ),
    { maxLength: 6 },
  )
  .map((parts) => parts.join(''));

/** Text with at least one non-white-space character. */
const nonBlankTextArb: fc.Arbitrary<string> = fc
  .tuple(textArb, wordArb, textArb)
  .map(([a, w, b]) => `${a}${w}${b}`);

/** Absent, empty, white-space-only, or a real value (the four shapes the parser must handle). */
const optionalFieldArb: fc.Arbitrary<string | undefined> = fc.oneof(
  { weight: 2, arbitrary: fc.constant<string | undefined>(undefined) },
  { weight: 1, arbitrary: fc.constant<string | undefined>('') },
  { weight: 1, arbitrary: whitespaceRunArb },
  { weight: 5, arbitrary: nonBlankTextArb },
);

const pathUnit = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789.-_~'.split('')) },
  { weight: 1, arbitrary: textUnit },
);

/** A package path with no white space (one to four segments). */
const pathCoreArb: fc.Arbitrary<string> = fc
  .array(fc.string({ unit: pathUnit, minLength: 1, maxLength: 10 }), { minLength: 1, maxLength: 4 })
  .map((segments) => segments.join('/'));

/** A path as it can appear between the parentheses: a valid core, optionally padded with white space. */
const paddedPathArb: fc.Arbitrary<string> = fc
  .tuple(whitespaceArb, pathCoreArb, whitespaceArb)
  .map(([a, p, b]) => `${a}${p}${b}`);

/** Entries a correct parser must return. */
export const validEntrySpecArb: fc.Arbitrary<EntrySpec> = fc.record({
  name: nonBlankTextArb,
  path: paddedPathArb,
  synopsis: optionalFieldArb,
  version: optionalFieldArb,
  published: optionalFieldArb,
  importedBy: optionalFieldArb,
});

type SpecPatch = Partial<Pick<{ -readonly [K in keyof EntrySpec]: EntrySpec[K] }, 'name' | 'path'>>;

const invalidPatchArb: fc.Arbitrary<SpecPatch> = fc.oneof(
  // Missing path span.
  fc.constant<SpecPatch>({ path: undefined }),
  // Empty or white-space-only path.
  fc.constant<SpecPatch>({ path: '' }),
  whitespaceRunArb.map((ws): SpecPatch => ({ path: ws })),
  // Path with white space inside.
  fc
    .tuple(whitespaceArb, pathCoreArb, whitespaceRunArb, pathCoreArb, whitespaceArb)
    .map(([a, p, ws, q, b]): SpecPatch => ({ path: `${a}${p}${ws}${q}${b}` })),
  // Missing or empty name.
  fc.constant<SpecPatch>({ name: undefined }),
  fc.constant<SpecPatch>({ name: '' }),
  whitespaceRunArb.map((ws): SpecPatch => ({ name: ws })),
  // No title at all.
  fc.constant<SpecPatch>({ name: undefined, path: undefined }),
);

/** Entries a correct parser must drop (Requirement 3.6). */
export const invalidEntrySpecArb: fc.Arbitrary<EntrySpec> = fc
  .tuple(validEntrySpecArb, invalidPatchArb)
  .map(([spec, patch]) => ({ ...spec, ...patch }));

/** Mostly valid, sometimes invalid. */
export const anyEntrySpecArb: fc.Arbitrary<EntrySpec> = fc.oneof(
  { weight: 3, arbitrary: validEntrySpecArb },
  { weight: 1, arbitrary: invalidEntrySpecArb },
);

// ---------------------------------------------------------------------------
// Spec -> expected PackageResult
// ---------------------------------------------------------------------------

/** Collapses runs of white space into single spaces and trims (Requirement 3.4). */
export function normalizeText(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

export function isValidEntrySpec(spec: EntrySpec): boolean {
  if (spec.name === undefined || spec.path === undefined) {
    return false;
  }
  const path = spec.path.trim();
  return normalizeText(spec.name) !== '' && path !== '' && !/\s/u.test(path);
}

/** What the parser must return for this entry, or `undefined` when it must be dropped. */
export function expectedResult(spec: EntrySpec): PackageResult | undefined {
  if (!isValidEntrySpec(spec)) {
    return undefined;
  }
  const result: { -readonly [K in keyof PackageResult]: PackageResult[K] } = {
    path: (spec.path as string).trim(),
    name: normalizeText(spec.name as string),
  };
  for (const key of OPTIONAL_KEYS) {
    const raw = spec[key];
    if (raw !== undefined) {
      const value = normalizeText(raw);
      if (value !== '') {
        result[key] = value;
      }
    }
  }
  return result;
}

/** Expected parser output for a sequence of specs: valid ones, in order, duplicates kept. */
export function expectedResults(specs: readonly EntrySpec[]): PackageResult[] {
  const results: PackageResult[] = [];
  for (const spec of specs) {
    const result = expectedResult(spec);
    if (result !== undefined) {
      results.push(result);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Noise (data, not randomness inside the renderer)
// ---------------------------------------------------------------------------

export type EscapeStyle = 'minimal' | 'named' | 'decimal' | 'hex' | 'mixed' | 'all';
export type AttrQuote = 'double' | 'single' | 'unquoted';
export type FieldKey = 'name' | 'path' | 'synopsis' | 'version' | 'published' | 'importedBy';

export interface ExtraAttr {
  readonly name: string;
  readonly value: string;
  readonly quote: AttrQuote;
  readonly style: EscapeStyle;
  /** Class added to the element (merged into an existing class attribute). */
  readonly extraClass: string | undefined;
  readonly classFirst: boolean;
}

/** An inline element wrapped around a slice of a value (code point offsets, clamped to the value). */
export interface Wrap {
  readonly tag: string;
  readonly from: number;
  readonly to: number;
  readonly attr: ExtraAttr | undefined;
}

export interface EntryNoise {
  readonly escapes: Readonly<Record<FieldKey, EscapeStyle>>;
  readonly wraps: Readonly<Record<FieldKey, Wrap | undefined>>;
  /** Filler (white space, comments, raw-text blocks) inserted round-robin at structural gaps. */
  readonly gaps: readonly string[];
  /** Extra attributes/classes handed out round-robin, one per element. */
  readonly attrs: readonly (ExtraAttr | undefined)[];
  readonly attrSep: string;
  readonly quote: AttrQuote;
  readonly reverseAttrs: boolean;
  readonly tagCase: 'lower' | 'upper';
  readonly titleHook: 'testId' | 'fallback';
  readonly importedMarker: 'both' | 'href' | 'aria';
  readonly license: { readonly text: string; readonly strong: boolean } | undefined;
  readonly otherMajor: readonly string[] | undefined;
  readonly otherModule: { readonly module: string; readonly chips: readonly string[] } | undefined;
  readonly blocksFirst: boolean;
}

export interface PageNoise {
  readonly gaps: readonly string[];
  readonly decoys: boolean;
}

export interface EntryModel {
  readonly spec: EntrySpec;
  readonly noise: EntryNoise;
}

export interface PageModel {
  readonly entries: readonly EntryModel[];
  readonly noise: PageNoise;
}

/** No noise at all: the shape of the sample page. */
export const PLAIN_NOISE: EntryNoise = {
  escapes: { name: 'named', path: 'named', synopsis: 'named', version: 'named', published: 'named', importedBy: 'named' },
  wraps: {
    name: undefined,
    path: undefined,
    synopsis: undefined,
    version: undefined,
    published: undefined,
    importedBy: undefined,
  },
  gaps: ['\n          '],
  attrs: [],
  attrSep: ' ',
  quote: 'double',
  reverseAttrs: false,
  tagCase: 'lower',
  titleHook: 'testId',
  importedMarker: 'both',
  license: { text: 'Apache-2.0', strong: false },
  otherMajor: undefined,
  otherModule: undefined,
  blocksFirst: false,
};

export const PLAIN_PAGE_NOISE: PageNoise = { gaps: ['\n    '], decoys: false };

export function plainEntry(spec: EntrySpec): EntryModel {
  return { spec, noise: PLAIN_NOISE };
}

export function plainPage(specs: readonly EntrySpec[]): PageModel {
  return { entries: specs.map(plainEntry), noise: PLAIN_PAGE_NOISE };
}

// --- noise generators ------------------------------------------------------

const FAKE_SNIPPET =
  '<div class="SearchSnippet"><h2><a data-test-id="snippet-title" href="https://pkg.go.dev/fake">fake' +
  '<span class="SearchSnippet-header-path">(fake.example/pkg)</span></a></h2>' +
  '<p class="SearchSnippet-synopsis">fake synopsis</p>' +
  '<div class="SearchSnippet-infoLabel"><strong>v9.9.9</strong></div></div>';

const DECOY_MARKUP =
  '<div class="SearchSnippet-headerContainer"><h2><a data-test-id="snippet-title" href="https://pkg.go.dev/decoy">decoy' +
  '<span class="SearchSnippet-header-path">(decoy.example/path)</span></a></h2></div>' +
  '<p class="SearchSnippet-synopsis">decoy synopsis</p>' +
  '<div class="SearchSnippet-infoLabel"><strong>v0.0.0</strong></div>';

const HTML_SPACE_CHARS = [' ', ' ', '\t', '\n', '\r', '\f'];

/** HTML white space only (what separates attributes). */
const htmlSpaceArb = fc
  .array(fc.constantFrom(...HTML_SPACE_CHARS), { minLength: 1, maxLength: 4 })
  .map((chars) => chars.join(''));

const optionalHtmlSpaceArb = fc
  .array(fc.constantFrom(...HTML_SPACE_CHARS), { maxLength: 12 })
  .map((chars) => chars.join(''));

const safeWordsArb = fc.stringMatching(/^[A-Za-z0-9 ]{0,12}$/);

const commentBodyArb = fc
  .oneof(
    textArb,
    fc.constant(` ${FAKE_SNIPPET} `),
    fc.constant(' <script> <style> '),
  )
  .filter((s) => !s.includes('-->'));

/** One filler item: white space, a comment, or a raw-text block carrying fake `SearchSnippet` markup. */
const fillerArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 6, arbitrary: optionalHtmlSpaceArb },
  {
    weight: 2,
    arbitrary: fc
      .tuple(optionalHtmlSpaceArb, commentBodyArb, optionalHtmlSpaceArb)
      .map(([a, body, b]) => `${a}<!--${body}-->${b}`),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(optionalHtmlSpaceArb, safeWordsArb, fc.boolean())
      .map(([a, words, upper]) => {
        const tag = upper ? 'SCRIPT' : 'script';
        return `${a}<${tag} type="text/javascript">var s = '${FAKE_SNIPPET}'; // ${words}</${tag}>`;
      }),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(optionalHtmlSpaceArb, safeWordsArb)
      .map(([a, words]) => `${a}<style>.SearchSnippet { color: red; } /* ${words} ${FAKE_SNIPPET} */</style>`),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(optionalHtmlSpaceArb, safeWordsArb)
      .map(([a, words]) => `${a}<textarea>${words}${FAKE_SNIPPET}</textarea>`),
  },
);

const gapsArb = fc.array(fillerArb, { maxLength: 5 });

const escapeStyleArb = fc.constantFrom<EscapeStyle>('minimal', 'named', 'decimal', 'hex', 'mixed', 'all');
const attrQuoteArb = fc.constantFrom<AttrQuote>('double', 'single', 'unquoted');

// Names and classes the parser does not look at.
const extraAttrArb: fc.Arbitrary<ExtraAttr> = fc.record({
  name: fc.constantFrom('id', 'title', 'lang', 'data-x', 'data-rank', 'data-gtmv', 'role', 'tabindex', 'style'),
  value: textArb,
  quote: attrQuoteArb,
  style: escapeStyleArb,
  extraClass: fc.option(fc.constantFrom('go-textSubtle', 'go-Chip', 'foo', 'bar-baz', 'SearchSnippet-extra'), {
    nil: undefined,
  }),
  classFirst: fc.boolean(),
});

const wrapArb: fc.Arbitrary<Wrap | undefined> = fc.option(
  fc.record({
    tag: fc.constantFrom('span', 'em', 'b', 'i', 'code', 'small', 'strong', 'abbr', 'mark', 'u'),
    from: fc.nat({ max: 40 }),
    to: fc.nat({ max: 40 }),
    attr: fc.option(extraAttrArb, { nil: undefined }),
  }),
  { nil: undefined, freq: 3 },
);

function recordOfFields<T>(arb: fc.Arbitrary<T>): fc.Arbitrary<Record<FieldKey, T>> {
  return fc.record({
    name: arb,
    path: arb,
    synopsis: arb,
    version: arb,
    published: arb,
    importedBy: arb,
  });
}

export const entryNoiseArb: fc.Arbitrary<EntryNoise> = fc.record({
  escapes: recordOfFields(escapeStyleArb),
  wraps: recordOfFields(wrapArb),
  gaps: gapsArb,
  attrs: fc.array(fc.option(extraAttrArb, { nil: undefined, freq: 2 }), { maxLength: 4 }),
  attrSep: htmlSpaceArb,
  quote: attrQuoteArb,
  reverseAttrs: fc.boolean(),
  tagCase: fc.constantFrom<'lower' | 'upper'>('lower', 'lower', 'upper'),
  titleHook: fc.constantFrom<'testId' | 'fallback'>('testId', 'testId', 'fallback'),
  importedMarker: fc.constantFrom<'both' | 'href' | 'aria'>('both', 'both', 'href', 'aria'),
  license: fc.option(fc.record({ text: nonBlankTextArb, strong: fc.boolean() }), { nil: undefined, freq: 3 }),
  otherMajor: fc.option(fc.array(textArb, { maxLength: 3 }), { nil: undefined }),
  otherModule: fc.option(
    fc.record({ module: textArb, chips: fc.array(textArb, { maxLength: 4 }) }),
    { nil: undefined },
  ),
  blocksFirst: fc.boolean(),
});

export const pageNoiseArb: fc.Arbitrary<PageNoise> = fc.record({ gaps: gapsArb, decoys: fc.boolean() });

export function entryModelArb(specArb: fc.Arbitrary<EntrySpec> = validEntrySpecArb): fc.Arbitrary<EntryModel> {
  return fc.record({ spec: specArb, noise: entryNoiseArb });
}

export interface PageModelOptions {
  readonly specArb?: fc.Arbitrary<EntrySpec>;
  readonly minEntries?: number;
  readonly maxEntries?: number;
}

/** A page of entries (valid only by default; pass `anyEntrySpecArb` to mix in invalid ones). */
export function pageModelArb(options: PageModelOptions = {}): fc.Arbitrary<PageModel> {
  return fc.record({
    entries: fc.array(entryModelArb(options.specArb ?? validEntrySpecArb), {
      minLength: options.minEntries ?? 0,
      maxLength: options.maxEntries ?? 6,
    }),
    noise: pageNoiseArb,
  });
}

/** Expected parser output for a page model. */
export function expectedPageResults(page: PageModel): PackageResult[] {
  return expectedResults(page.entries.map((entry) => entry.spec));
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

const NAMED_REFERENCES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
  '\u00a0': '&nbsp;',
};

function numericReference(codePoint: number, index: number): string {
  if (index % 2 === 0) {
    return `&#${codePoint};`;
  }
  const hex = codePoint.toString(16);
  switch (index % 6) {
    case 1:
      return `&#x${hex};`;
    case 3:
      return `&#X${hex.toUpperCase()};`;
    default:
      return `&#x${hex.padStart(8, '0')};`;
  }
}

function escapeChar(ch: string, index: number, style: EscapeStyle, quotesAlways: boolean): string {
  const codePoint = ch.codePointAt(0) as number;
  const core = ch === '&' || ch === '<' || ch === '>';
  const quote = ch === '"' || ch === "'";
  const named = NAMED_REFERENCES[ch];
  switch (style) {
    case 'all':
      return numericReference(codePoint, index);
    case 'minimal':
      return core || (quote && quotesAlways) ? (named as string) : ch;
    case 'named':
      return named ?? ch;
    case 'decimal':
      return core || quote || ch === '+' ? `&#${codePoint};` : ch;
    case 'hex':
      return core || quote || ch === '+' ? `&#x${codePoint.toString(16)};` : ch;
    case 'mixed': {
      if (!(core || quote || ch === '+' || named !== undefined)) {
        return ch;
      }
      const pick = index % 3;
      if (pick === 0 && named !== undefined) {
        return named;
      }
      return pick === 1 ? `&#${codePoint};` : `&#x${codePoint.toString(16).toUpperCase()};`;
    }
  }
}

function escapeChars(chars: readonly string[], style: EscapeStyle, quotesAlways: boolean, base = 0): string {
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    out += escapeChar(chars[i] as string, base + i, style, quotesAlways);
  }
  return out;
}

/** Escapes text for element content so that `decodeCharacterReferences` yields the original. */
export function escapeHtmlText(text: string, style: EscapeStyle = 'named'): string {
  return escapeChars(Array.from(text), style, false);
}

const SAFE_UNQUOTED = /^[\w\-./:?=]+$/;

function attrText(name: string, value: string, quote: AttrQuote, style: EscapeStyle): string {
  if (quote === 'unquoted' && SAFE_UNQUOTED.test(value)) {
    return `${name}=${value}`;
  }
  const q = quote === 'single' ? "'" : '"';
  // A quote of the active kind must always be escaped, whatever the style.
  return `${name}=${q}${escapeChars(Array.from(value), style, true)}${q}`;
}

function hrefFor(spec: EntrySpec): string {
  try {
    return `https://pkg.go.dev/${encodeURI((spec.path ?? '').trim())}`;
  } catch {
    return 'https://pkg.go.dev/x';
  }
}

class RenderContext {
  private gapIndex = 0;
  private attrIndex = 0;

  constructor(private readonly noise: EntryNoise) {}

  gap(): string {
    const gaps = this.noise.gaps;
    return gaps.length === 0 ? '' : (gaps[this.gapIndex++ % gaps.length] as string);
  }

  private tagName(name: string): string {
    return this.noise.tagCase === 'upper' ? name.toUpperCase() : name;
  }

  private nextExtra(): ExtraAttr | undefined {
    const pool = this.noise.attrs;
    return pool.length === 0 ? undefined : pool[this.attrIndex++ % pool.length];
  }

  private openTag(tag: string, attrs: readonly string[]): string {
    const sep = this.noise.attrSep;
    return `<${this.tagName(tag)}${attrs.map((a) => sep + a).join('')}>`;
  }

  private static closeTag(tag: string): string {
    return `</${tag}>`;
  }

  /** Attribute list for `extra` merged with an optional base class. */
  private attrList(
    base: ReadonlyArray<readonly [string, string]>,
    baseClass: string | undefined,
    extra: ExtraAttr | undefined,
  ): string[] {
    const n = this.noise;
    let className = baseClass;
    const rendered: string[] = [];
    if (extra !== undefined) {
      if (extra.extraClass !== undefined) {
        className =
          className === undefined
            ? extra.extraClass
            : extra.classFirst
              ? `${extra.extraClass}${n.attrSep}${className}`
              : `${className}${n.attrSep}${extra.extraClass}`;
      }
    }
    if (className !== undefined) {
      rendered.push(attrText(this.attrName('class'), className, n.quote, 'named'));
    }
    for (const [name, value] of base) {
      rendered.push(attrText(this.attrName(name), value, n.quote, 'named'));
    }
    if (extra !== undefined) {
      rendered.push(attrText(this.attrName(extra.name), extra.value, extra.quote, extra.style));
    }
    return n.reverseAttrs ? rendered.reverse() : rendered;
  }

  private attrName(name: string): string {
    return this.noise.tagCase === 'upper' ? name.toUpperCase() : name;
  }

  /** Element with fixed attributes, an optional base class, and the next pooled extra attribute. */
  el(
    tag: string,
    base: ReadonlyArray<readonly [string, string]>,
    inner: string,
    baseClass?: string,
  ): string {
    const attrs = this.attrList(base, baseClass, this.nextExtra());
    return `${this.openTag(tag, attrs)}${inner}${RenderContext.closeTag(tag)}`;
  }

  /** The text of one field, escaped in the field's style and optionally wrapped in an inline element. */
  value(text: string, key: FieldKey): string {
    const style = this.noise.escapes[key];
    const wrap = this.noise.wraps[key];
    const chars = Array.from(text);
    if (wrap === undefined) {
      return escapeChars(chars, style, false);
    }
    let from = Math.min(wrap.from, chars.length);
    let to = Math.min(wrap.to, chars.length);
    if (from > to) {
      [from, to] = [to, from];
    }
    const attrs = this.attrList([], undefined, wrap.attr);
    return (
      escapeChars(chars.slice(0, from), style, false, 0) +
      this.openTag(wrap.tag, attrs) +
      escapeChars(chars.slice(from, to), style, false, from) +
      RenderContext.closeTag(wrap.tag) +
      escapeChars(chars.slice(to), style, false, to)
    );
  }
}

/** Renders one entry as a `SearchSnippet` block shaped like `sample-pages/SearchResults.html`. */
export function renderEntry(model: EntryModel): string {
  const { spec, noise } = model;
  const c = new RenderContext(noise);
  const parts: string[] = [];

  // Title: name text and the path span inside one link inside an h2.
  if (spec.name !== undefined || spec.path !== undefined) {
    const name = spec.name === undefined ? '' : c.value(spec.name, 'name');
    const path =
      spec.path === undefined
        ? ''
        : c.el('span', [], `(${c.value(spec.path, 'path')})`, 'SearchSnippet-header-path');
    const linkAttrs: Array<readonly [string, string]> = [
      ['href', hrefFor(spec)],
      ['data-gtmc', 'search result'],
    ];
    if (noise.titleHook === 'testId') {
      linkAttrs.push(['data-test-id', 'snippet-title']);
    }
    const link = c.el('a', linkAttrs, `${c.gap()}${name}${c.gap()}${path}${c.gap()}`);
    const heading = c.el('h2', [], `${c.gap()}${link}${c.gap()}`);
    parts.push(c.el('div', [], `${c.gap()}${heading}${c.gap()}`, 'SearchSnippet-headerContainer'));
  }

  if (spec.synopsis !== undefined) {
    parts.push(
      c.el(
        'p',
        [['data-test-id', 'snippet-synopsis']],
        `${c.gap()}${c.value(spec.synopsis, 'synopsis')}${c.gap()}`,
        'SearchSnippet-synopsis',
      ),
    );
  }

  const info = renderInfoLabel(c, spec, noise);
  const blocks = renderBlocks(c, noise);
  if (noise.blocksFirst) {
    parts.push(blocks, info);
  } else {
    parts.push(info, blocks);
  }

  return `${c.el('div', [], parts.map((part) => `${c.gap()}${part}`).join('') + c.gap(), 'SearchSnippet')} `;
}

function renderInfoLabel(c: RenderContext, spec: EntrySpec, noise: EntryNoise): string {
  let imported = '';
  if (spec.importedBy !== undefined) {
    const href = hrefFor(spec);
    const linkAttrs: Array<readonly [string, string]> =
      noise.importedMarker === 'aria'
        ? [
            ['href', `${href}?tab=versions`],
            ['aria-label', 'Go to Imported By'],
          ]
        : noise.importedMarker === 'href'
          ? [['href', `${href}?tab=importedby`]]
          : [
              ['href', `${href}?tab=importedby`],
              ['aria-label', 'Go to Imported By'],
            ];
    imported = c.el(
      'a',
      linkAttrs,
      `${c.gap()}${c.el('span', [], 'Imported by ', 'go-textSubtle')}` +
        c.el('strong', [], `${c.gap()}${c.value(spec.importedBy, 'importedBy')}${c.gap()}`) +
        c.gap(),
    );
  }

  let middle = '';
  if (spec.version !== undefined || spec.published !== undefined) {
    const version =
      spec.version === undefined
        ? ''
        : c.el('strong', [], `${c.gap()}${c.value(spec.version, 'version')}${c.gap()}`);
    const published =
      spec.published === undefined
        ? ''
        : ' published on ' +
          c.el(
            'span',
            [['data-test-id', 'snippet-published']],
            c.el('strong', [], `${c.gap()}${c.value(spec.published, 'published')}${c.gap()}`),
          );
    middle = c.el('span', [], `${c.gap()}${version}${published}${c.gap()}`, 'go-textSubtle');
  }

  let license = '';
  if (noise.license !== undefined) {
    const text = escapeHtmlText(noise.license.text, 'named');
    const link = c.el(
      'a',
      [
        ['href', `${hrefFor(spec)}?tab=licenses`],
        ['aria-label', 'Go to Licenses'],
      ],
      `${c.gap()}${text}${c.gap()}`,
    );
    const strong = noise.license.strong ? c.el('strong', [], 'MIT') : '';
    license = c.el('span', [['data-test-id', 'snippet-license']], `${c.gap()}${link}${strong}${c.gap()}`);
  }

  if (imported === '' && middle === '' && license === '') {
    return '';
  }
  const separator = (): string => c.el('span', [], '|', 'go-textSubtle');
  const pieces = [imported, middle, license].filter((piece) => piece !== '');
  const inner = pieces.map((piece) => `${c.gap()}${piece}`).join(separator());
  return c.el('div', [], `${inner}${c.gap()}`, 'SearchSnippet-infoLabel');
}

function renderBlocks(c: RenderContext, noise: EntryNoise): string {
  let out = '';
  if (noise.otherMajor !== undefined) {
    const versions = noise.otherMajor
      .map((version) =>
        c.el(
          'a',
          [
            ['href', 'https://pkg.go.dev/other/v1'],
            ['data-gtmc', 'search result other major'],
          ],
          `${c.gap()}${c.el('strong', [], escapeHtmlText(version, 'named'))}${c.el('span', [], '', 'go-textSubtle')}${c.gap()}`,
        ),
      )
      .join(c.gap());
    out +=
      c.gap() +
      c.el('div', [], `${c.gap()}${c.el('span', [], 'Other major versions:', 'go-textSubtle')}${c.gap()}${versions}`, 'go-textSubtle');
  }
  if (noise.otherModule !== undefined) {
    const heading = c.el('strong', [], `Other packages in module ${escapeHtmlText(noise.otherModule.module, 'named')}:`);
    const chips = noise.otherModule.chips
      .map((chip) =>
        c.el(
          'a',
          [
            ['href', 'https://pkg.go.dev/other/chip'],
            ['data-gtmc', 'search result same module'],
          ],
          `${c.gap()}${escapeHtmlText(chip, 'named')}${c.gap()}`,
          'go-Chip go-Chip--subtle',
        ),
      )
      .join(c.gap());
    out += c.gap() + c.el('div', [], `${c.gap()}${heading}${c.gap()}${chips}`, 'SearchSnippet-sub go-textSubtle');
  }
  return out;
}

/** Renders a whole results page: head, summary, entries (plus noise), footer. */
export function renderPage(page: PageModel): string {
  const gaps = page.noise.gaps;
  let gapIndex = 0;
  const gap = (): string => (gaps.length === 0 ? '' : (gaps[gapIndex++ % gaps.length] as string));
  const decoy = page.noise.decoys ? DECOY_MARKUP : '';
  const entries = page.entries.map((entry) => `${gap()}${renderEntry(entry)}`).join('');
  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>mongodb - Search Results - Go Packages</title>',
    `${gap()}<style>.SearchSnippet { margin: 0; }</style>`,
    '</head>',
    '<body>',
    gap(),
    '<main>',
    '<div class="SearchResults-summary" role="heading" aria-level="1">',
    `Showing <strong>${page.entries.length}</strong> modules with matching packages. <a href="https://pkg.go.dev/search-help">Search help</a>`,
    '</div>',
    decoy,
    '<div>',
    entries,
    '</div>',
    decoy,
    '</main>',
    gap(),
    '</body>',
    '</html>',
    '',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// SearchController test doubles
// ---------------------------------------------------------------------------

/** Lets already-resolved promises run their continuations (the controller settles via `.then`). */
export function flushPromises(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** Instant used by `fixedClock`; the controller writes it as ISO 8601 in log lines. */
export const FIXED_NOW = new Date('2024-01-02T03:04:05.678Z');
export const FIXED_TIMESTAMP = FIXED_NOW.toISOString();

/** A clock that always returns the same instant (a new `Date` each call). */
export const fixedClock = (): Date => new Date(FIXED_NOW.getTime());

/** `OutputLike` that records every line in order. */
export class RecordingOutput implements OutputLike {
  readonly lines: string[] = [];

  appendLine(value: string): void {
    this.lines.push(value);
  }
}

/** One `client.search(url, signal)` call, with a deferred the test settles by hand. */
export class RecordedSearch {
  private done = false;
  private resolveFn: ((response: SearchResponse) => void) | undefined;
  readonly promise: Promise<SearchResponse>;
  /** Number of `abort` events observed on `signal` (0 or 1). */
  abortEvents = 0;

  constructor(
    /** Position in `FakeSearchClient.calls`. */
    readonly index: number,
    readonly url: string,
    readonly signal: AbortSignal,
    /** Indexes of earlier calls that were neither settled nor aborted when this call was made. */
    readonly liveEarlier: readonly number[],
  ) {
    this.promise = new Promise<SearchResponse>((resolve) => {
      this.resolveFn = resolve;
    });
    signal.addEventListener('abort', () => {
      this.abortEvents++;
    });
  }

  /** True once the test has settled this call (the first settle wins, later ones are ignored). */
  get settled(): boolean {
    return this.done;
  }

  /** True once the controller aborted this request's signal. */
  get aborted(): boolean {
    return this.signal.aborted;
  }

  /** Settles the deferred. Returns false when it was already settled. */
  settle(response: SearchResponse): boolean {
    if (this.done) {
      return false;
    }
    this.done = true;
    this.resolveFn?.(response);
    return true;
  }
}

/** `SearchClient` that records each call and leaves it pending until the test settles it. */
export class FakeSearchClient implements SearchClient {
  readonly calls: RecordedSearch[] = [];

  search(url: string, signal: AbortSignal): Promise<SearchResponse> {
    const liveEarlier = this.calls.filter((c) => !c.settled && !c.aborted).map((c) => c.index);
    const call = new RecordedSearch(this.calls.length, url, signal, liveEarlier);
    this.calls.push(call);
    return call.promise;
  }

  /** Calls that are neither settled nor aborted. */
  get live(): readonly RecordedSearch[] {
    return this.calls.filter((c) => !c.settled && !c.aborted);
  }
}

/** Everything a controller property needs, wired to deterministic doubles. */
export interface ControllerHarness {
  readonly timers: FakeTimers;
  readonly client: FakeSearchClient;
  readonly output: RecordingOutput;
  readonly controller: SearchController;
  /** URLs passed to `openExternal`. */
  readonly opened: string[];
  /** Messages passed to `showError`. */
  readonly errors: string[];
  /** Every state the controller emitted, in order. */
  readonly states: SearchController['state'][];
}

export interface HarnessOptions {
  readonly openExternal?: SearchControllerDeps['openExternal'];
  readonly debounceMs?: number;
  readonly timeoutMs?: number;
}

export function createControllerHarness(options: HarnessOptions = {}): ControllerHarness {
  const timers = new FakeTimers();
  const client = new FakeSearchClient();
  const output = new RecordingOutput();
  const opened: string[] = [];
  const errors: string[] = [];
  const controller = new SearchController({
    client,
    output,
    timers,
    now: fixedClock,
    openExternal:
      options.openExternal ??
      ((url) => {
        opened.push(url);
        return Promise.resolve(true);
      }),
    showError: (message) => {
      errors.push(message);
    },
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  const states: SearchController['state'][] = [];
  controller.onDidChangeState((state) => {
    states.push(state);
  });
  return { timers, client, output, controller, opened, errors, states };
}

// ---------------------------------------------------------------------------
// Event scripts
// ---------------------------------------------------------------------------

/** How a search ends when the test settles it. Timeouts come from `advance`, not from here. */
export type SettleOutcome =
  | { readonly kind: 'ok'; readonly html: string; readonly results: readonly PackageResult[] }
  | { readonly kind: 'unreachable'; readonly reason: string }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'redirectBlocked'; readonly status: number; readonly targetHost: string }
  | { readonly kind: 'aborted' };

/**
 * One step of a script.
 *  - `query`: the Search_Box text changed (`controller.queryChanged`).
 *  - `submit`: Enter was pressed (`controller.submit`).
 *  - `advance`: the fake clock moves forward by `ms`.
 *  - `settle`: the search at `searchIndex` finishes with `outcome`. `searchIndex` is any natural
 *    number, resolved against the searches started so far with `targetSearchIndex`; it is a no-op
 *    when none has started yet or the target was already settled.
 */
export type ScriptEvent =
  | { readonly type: 'query'; readonly text: string }
  | { readonly type: 'submit'; readonly text: string }
  | { readonly type: 'advance'; readonly ms: number }
  | { readonly type: 'settle'; readonly searchIndex: number; readonly outcome: SettleOutcome };

/** Resolves a generated `searchIndex` to a started search (`index % count`), or undefined if none. */
export function targetSearchIndex(searchIndex: number, count: number): number | undefined {
  return count === 0 ? undefined : searchIndex % count;
}

/** The `SearchResponse` the fake client delivers for an outcome. */
export function toSearchResponse(outcome: SettleOutcome): SearchResponse {
  switch (outcome.kind) {
    case 'ok':
      return { kind: 'ok', html: outcome.html };
    case 'unreachable':
      return { kind: 'failed', failure: { kind: 'unreachable', reason: outcome.reason } };
    case 'http':
      return { kind: 'failed', failure: { kind: 'http', status: outcome.status } };
    case 'redirectBlocked':
      return {
        kind: 'failed',
        failure: { kind: 'redirectBlocked', status: outcome.status, targetHost: outcome.targetHost },
      };
    case 'aborted':
      return { kind: 'aborted' };
  }
}

/**
 * Applies one event to a harness. Synchronous events run synchronously; `settle` also lets the
 * controller's promise continuation run before returning, so await the result of every call.
 */
export async function applyEvent(harness: ControllerHarness, event: ScriptEvent): Promise<void> {
  switch (event.type) {
    case 'query':
      harness.controller.queryChanged(event.text);
      return;
    case 'submit':
      harness.controller.submit(event.text);
      return;
    case 'advance':
      harness.timers.advance(event.ms);
      return;
    case 'settle': {
      const target = targetSearchIndex(event.searchIndex, harness.client.calls.length);
      if (target === undefined) {
        return;
      }
      harness.client.calls[target]?.settle(toSearchResponse(event.outcome));
      await flushPromises();
      return;
    }
  }
}

/** Runs a whole script against a harness. */
export async function runScript(harness: ControllerHarness, script: readonly ScriptEvent[]): Promise<void> {
  for (const event of script) {
    await applyEvent(harness, event);
  }
}

// --- generators ------------------------------------------------------------

/** Small, mostly-plain pages: the number of results varies, the markup noise does not. */
const okOutcomeArb: fc.Arbitrary<SettleOutcome> = fc
  .array(validEntrySpecArb, { maxLength: 3 })
  .map((specs) => ({
    kind: 'ok' as const,
    html: renderPage(plainPage(specs)),
    results: expectedResults(specs),
  }));

const FAILURE_CODES = ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN'];

const failureReasonArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(...FAILURE_CODES),
  fc.string({ maxLength: 20 }),
  fc.constant('socket hang up\nsecond line'),
);

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const REDIRECT_HOSTS = ['evil.example', 'pkg.go.dev.evil.com', 'localhost:8443', 'example.org', '(invalid URL)'];

/**
 * How a search can end through the client: `ok` pages (0-3 results), each failure kind, or
 * `aborted`. Weighted toward `ok` and the failures; `aborted` is rare because a real client only
 * returns it for requests the controller already superseded.
 */
export const settleOutcomeArb: fc.Arbitrary<SettleOutcome> = fc.oneof(
  { weight: 5, arbitrary: okOutcomeArb },
  { weight: 1, arbitrary: failureReasonArb.map((reason): SettleOutcome => ({ kind: 'unreachable', reason })) },
  {
    weight: 1,
    arbitrary: fc
      .oneof(fc.integer({ min: 100, max: 199 }), fc.integer({ min: 300, max: 599 }))
      .map((status): SettleOutcome => ({ kind: 'http', status })),
  },
  {
    weight: 1,
    arbitrary: fc
      .tuple(fc.constantFrom(...REDIRECT_STATUSES), fc.constantFrom(...REDIRECT_HOSTS))
      .map(([status, targetHost]): SettleOutcome => ({ kind: 'redirectBlocked', status, targetHost })),
  },
  { weight: 1, arbitrary: fc.constant<SettleOutcome>({ kind: 'aborted' }) },
);

/** Debounce_Delay and Request_Timeout used by the controller defaults. */
export const DEBOUNCE_MS = 400;
export const TIMEOUT_MS = 10_000;

/**
 * Time steps that straddle the interesting thresholds: just under and exactly at the debounce
 * delay, long enough to fire several debounces, and around the request timeout.
 */
export const advanceMsArb: fc.Arbitrary<number> = fc.oneof(
  { weight: 3, arbitrary: fc.integer({ min: 0, max: DEBOUNCE_MS - 1 }) },
  { weight: 2, arbitrary: fc.constant(DEBOUNCE_MS) },
  { weight: 1, arbitrary: fc.integer({ min: DEBOUNCE_MS, max: 2 * DEBOUNCE_MS }) },
  { weight: 1, arbitrary: fc.integer({ min: TIMEOUT_MS - 2, max: TIMEOUT_MS + 2 }) },
  { weight: 1, arbitrary: fc.integer({ min: 0, max: TIMEOUT_MS + 2000 }) },
);

/**
 * Box text drawn from a small pool of queries so the same Search_Query recurs (exercising the
 * "same query as the latest search" rule), padded with white space (so different texts share one
 * Search_Query), plus empty/white-space-only text and the occasional unrelated text.
 */
function poolTextArb(pool: readonly string[]): fc.Arbitrary<string> {
  return fc.oneof(
    {
      weight: 6,
      arbitrary: fc
        .tuple(whitespaceArb, fc.constantFrom(...pool), whitespaceArb)
        .map(([a, q, b]) => `${a}${q}${b}`),
    },
    { weight: 2, arbitrary: whitespaceArb },
    { weight: 1, arbitrary: boxTextArb },
  );
}

export interface ScriptOptions {
  readonly minLength?: number;
  readonly maxLength?: number;
}

/**
 * Event scripts for `SearchController`: `query`, `submit`, `advance`, and `settle` events in any
 * order, with `settle` free to target any started search (earlier ones, the latest, or ones already
 * superseded, aborted, or timed out). Every text is drawn from a per-script pool of 1-3 queries.
 */
export function searchScriptArb(options: ScriptOptions = {}): fc.Arbitrary<ScriptEvent[]> {
  return fc
    .array(queryArb, { minLength: 1, maxLength: 3 })
    .chain((pool) => {
      const text = poolTextArb(pool);
      const event: fc.Arbitrary<ScriptEvent> = fc.oneof(
        { weight: 4, arbitrary: text.map((t): ScriptEvent => ({ type: 'query', text: t })) },
        { weight: 2, arbitrary: text.map((t): ScriptEvent => ({ type: 'submit', text: t })) },
        { weight: 4, arbitrary: advanceMsArb.map((ms): ScriptEvent => ({ type: 'advance', ms })) },
        {
          weight: 4,
          arbitrary: fc
            .tuple(fc.nat({ max: 20 }), settleOutcomeArb)
            .map(([searchIndex, outcome]): ScriptEvent => ({ type: 'settle', searchIndex, outcome })),
        },
      );
      return fc.array(event, { minLength: options.minLength ?? 1, maxLength: options.maxLength ?? 30 });
    });
}
