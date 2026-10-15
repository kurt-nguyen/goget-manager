/**
 * Shared fast-check generators for the go.mod parser and printer properties.
 *
 * Main exports:
 *  - `validTokenArb`, `validDependencyArb`: building blocks (design "Shared generator definitions").
 *  - `layoutArb`: clean layouts (single-line requires and require blocks, no noise).
 *  - `noisyLayoutArb`: layouts decorated with presentation noise (comments, blank lines,
 *    whitespace, `// indirect`, quoting, CRLF, BOM, non-require directives and blocks).
 *    Noise is stored as data inside the layout, so it shrinks and renders deterministically.
 *  - `cleanLayout(layout)`: the same dependencies with all noise removed (for Property 2).
 *  - `renderLayout(layout)`: renders text and records 1-based line numbers for every
 *    dependency and chunk (for the defect injection in Property 3).
 *  - `missingTokenTopLevelLineArb`, `missingTokenBlockLineArb`, `UNCLOSED_REQUIRE_LINE`:
 *    replacement lines that are guaranteed to be parse defects.
 *  - Installed-view snapshot generators (bottom of the file, used by Properties 8-12):
 *    `folderStateArb`, `snapshotArb`, and the shaped variants
 *    (`snapshotManyPresentArb`, `snapshotOnePresentArb`, `snapshotNoFoldersArb`, `snapshotNoPresentArb`),
 *    `snapshotWithTargetArb` / `errorReplacementArb` / `snapshotWithErrorMutationArb`.
 *
 * Parser facts these generators rely on (see src/core/goModParser.ts):
 *  - Tokens are separated by space/tab only, and `//` only starts a comment at the start of a token,
 *    so a comment is always preceded by whitespace here.
 *  - A block opens only on exactly `require` `(`; `require ()` (one token `()`) is an empty block;
 *    `require ( )` is a dependency with path `(` and version `)`.
 *  - A block closes only on a line whose sole token is `)`.
 */
import * as fc from 'fast-check';
import type { GoModParseError, PackageDependency } from '../../src/core/goModParser';
import type { FolderGoModState, InstalledSnapshot } from '../../src/core/installedModel';

// ---------------------------------------------------------------------------
// Tokens and dependencies
// ---------------------------------------------------------------------------

/** Values that are legal tokens but easy for a naive parser to mishandle. */
export const TRICKY_TOKENS: readonly string[] = ['(', ')', '()', 'a//b', 'require', 'module'];

/**
 * A valid token is non-empty, has no whitespace, no `"`, `` ` `` or `'`,
 * and does not start with `//`.
 */
export function isValidToken(s: string): boolean {
  return s.length > 0 && !/\s/.test(s) && !/["`']/.test(s) && !s.startsWith('//');
}

const asciiUnit = fc
  .integer({ min: 0x21, max: 0x7e })
  .filter((cp) => cp !== 0x22 && cp !== 0x27 && cp !== 0x60)
  .map((cp) => String.fromCodePoint(cp));

/** Non-ASCII BMP characters outside the surrogate range, without whitespace. */
const bmpUnit = fc
  .oneof(fc.integer({ min: 0xa1, max: 0xd7ff }), fc.integer({ min: 0xe000, max: 0xfffd }))
  .map((cp) => String.fromCodePoint(cp))
  .filter((c) => !/\s/.test(c));

const astralUnit = fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp));

const tokenOf = (unit: fc.Arbitrary<string>) =>
  fc.string({ unit, minLength: 1, maxLength: 10 }).filter(isValidToken);

/** Realistic module path such as `github.com/ab/cd`. */
const modulePathArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom('github.com', 'golang.org/x', 'example.com', 'gopkg.in', 'k8s.io'),
    fc.array(fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,7}$/), { minLength: 1, maxLength: 3 }),
  )
  .map(([host, segs]) => `${host}/${segs.join('/')}`);

/** Realistic version: release, pre-release, `+incompatible`, or pseudo-version. */
const versionArb: fc.Arbitrary<string> = fc.oneof(
  fc
    .tuple(fc.nat(30), fc.nat(30), fc.nat(30))
    .map(([a, b, c]) => `v${a}.${b}.${c}`),
  fc.tuple(fc.nat(9), fc.nat(9), fc.nat(9)).map(([a, b, c]) => `v${a}.${b}.${c}-rc.1`),
  fc.nat(9).map((a) => `v${a + 2}.0.0+incompatible`),
  fc.stringMatching(/^[0-9a-f]{12}$/).map((h) => `v0.0.0-20210102030405-${h}`),
);

/** Valid token: ASCII, non-ASCII, astral, and tricky values. */
export const validTokenArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 5, arbitrary: tokenOf(asciiUnit) },
  { weight: 3, arbitrary: tokenOf(fc.oneof(asciiUnit, bmpUnit)) },
  { weight: 3, arbitrary: tokenOf(fc.oneof(asciiUnit, astralUnit)) },
  { weight: 3, arbitrary: fc.constantFrom(...TRICKY_TOKENS) },
);

/** Valid token that is never `(`, so it cannot open a block when it ends a directive line. */
const noOpenParenTokenArb = validTokenArb.filter((t) => t !== '(');
/** Valid token that is never `)`, so it can never close a block when alone on a line. */
const noCloseParenTokenArb = validTokenArb.filter((t) => t !== ')');

/** Valid dependency: both fields are valid tokens, sometimes realistic paths and versions. */
export const validDependencyArb: fc.Arbitrary<PackageDependency> = fc.record({
  path: fc.oneof({ weight: 3, arbitrary: validTokenArb }, { weight: 1, arbitrary: modulePathArb }),
  version: fc.oneof({ weight: 3, arbitrary: validTokenArb }, { weight: 1, arbitrary: versionArb }),
});

// ---------------------------------------------------------------------------
// Layout model
// ---------------------------------------------------------------------------

export type QuoteStyle = 'none' | 'double' | 'raw';

/** Presentation of one `path version` pair. Whitespace fields are made of spaces and tabs. */
export interface EntryStyle {
  /** Leading whitespace (may be empty). */
  readonly indent: string;
  /** Whitespace between path and version (never empty). */
  readonly gap: string;
  /** Whitespace after the version (may be empty). */
  readonly trail: string;
  /** Trailing comment, e.g. `// indirect`, or empty. */
  readonly comment: string;
  readonly pathQuote: QuoteStyle;
  readonly versionQuote: QuoteStyle;
}

export interface Entry {
  readonly dep: PackageDependency;
  readonly style: EntryStyle;
}

/** `require <path> <version>` on one line. */
export interface SingleChunk {
  readonly kind: 'single';
  readonly entry: Entry;
  /** Whitespace between `require` and the path (never empty). */
  readonly keywordGap: string;
  /** Complete noise lines emitted before this chunk (comments, blanks, other directives/blocks). */
  readonly before: readonly string[];
}

/** `require (` ... `)` block, or `require ()` when `inline` (only with zero entries). */
export interface BlockChunk {
  readonly kind: 'block';
  readonly entries: readonly Entry[];
  readonly before: readonly string[];
  /** Presentation of the `require (` line. `gap` sits between `require` and `(`. */
  readonly open: { readonly indent: string; readonly gap: string; readonly trail: string; readonly comment: string };
  /** Presentation of the `)` line. */
  readonly close: { readonly indent: string; readonly trail: string; readonly comment: string };
  /**
   * Noise lines inside the block. `innerBefore[i]` precedes entry `i`;
   * the last element (index `entries.length`) precedes the closing `)`.
   * Length is always `entries.length + 1`.
   */
  readonly innerBefore: readonly (readonly string[])[];
  /** Render an empty block as the single line `require ()`. */
  readonly inline: boolean;
}

export type Chunk = SingleChunk | BlockChunk;

export interface LayoutFormat {
  readonly eol: '\n' | '\r\n';
  /** Prefix the text with a UTF-8 BOM (U+FEFF). */
  readonly bom: boolean;
  /** End the text with a line terminator. */
  readonly finalNewline: boolean;
}

export interface Layout {
  readonly chunks: readonly Chunk[];
  /** Noise lines after the last chunk (comments, blanks, other directives/blocks). */
  readonly after: readonly string[];
  readonly format: LayoutFormat;
}

export const CLEAN_FORMAT: LayoutFormat = { eol: '\n', bom: false, finalNewline: true };

export const CLEAN_ENTRY_STYLE: EntryStyle = {
  indent: '',
  gap: ' ',
  trail: '',
  comment: '',
  pathQuote: 'none',
  versionQuote: 'none',
};

/** Dependencies declared by a layout, flattened in file order. */
export function expectedDependencies(layout: Layout): PackageDependency[] {
  return layout.chunks.flatMap((c) =>
    c.kind === 'single' ? [c.entry.dep] : c.entries.map((e) => e.dep),
  );
}

// ---------------------------------------------------------------------------
// Rendering with line-number records
// ---------------------------------------------------------------------------

export interface RenderedEntry {
  readonly dep: PackageDependency;
  /** 1-based line number of the entry. */
  readonly line: number;
  readonly chunkIndex: number;
  /** True for entries inside a `require (` block. */
  readonly inBlock: boolean;
}

export interface RenderedChunk {
  readonly kind: 'single' | 'block';
  readonly index: number;
  /** 1-based line of `require <path> <version>`, `require (`, or `require ()`. */
  readonly openLine: number;
  /** 1-based line of the closing `)`; equals `openLine` for single-line and inline-empty chunks. */
  readonly closeLine: number;
  /** 1-based lines of the entries in this chunk, in order. */
  readonly entryLines: readonly number[];
}

export interface RenderedLayout {
  readonly text: string;
  /** Physical lines without terminators; line `n` (1-based) is `lines[n - 1]`. */
  readonly lines: readonly string[];
  readonly lineCount: number;
  readonly format: LayoutFormat;
  readonly dependencies: readonly PackageDependency[];
  /** One record per dependency, in file order. */
  readonly entries: readonly RenderedEntry[];
  readonly chunks: readonly RenderedChunk[];
}

/** Joins physical lines into text using the layout's format (used after defect injection). */
export function joinLines(lines: readonly string[], format: LayoutFormat = CLEAN_FORMAT): string {
  const body = lines.join(format.eol);
  const tail = format.finalNewline && lines.length > 0 ? format.eol : '';
  return (format.bom ? '\uFEFF' : '') + body + tail;
}

function quoteToken(token: string, style: QuoteStyle): string {
  if (style === 'none') {
    return token;
  }
  // Interpreted strings treat `\` as an escape; use a raw string for those tokens.
  if (style === 'raw' || token.includes('\\')) {
    return '`' + token + '`';
  }
  return '"' + token + '"';
}

/** Trailing whitespace plus comment; a comment always gets at least one space before it. */
function tail(trail: string, comment: string): string {
  return comment === '' ? trail : (trail === '' ? ' ' : trail) + comment;
}

function entryText(e: Entry): string {
  const s = e.style;
  return (
    quoteToken(e.dep.path, s.pathQuote) +
    s.gap +
    quoteToken(e.dep.version, s.versionQuote) +
    tail(s.trail, s.comment)
  );
}

export function renderLayout(layout: Layout): RenderedLayout {
  const lines: string[] = [];
  const entries: RenderedEntry[] = [];
  const chunks: RenderedChunk[] = [];
  const push = (line: string): number => lines.push(line); // returns the 1-based line number

  layout.chunks.forEach((chunk, chunkIndex) => {
    chunk.before.forEach(push);

    if (chunk.kind === 'single') {
      const e = chunk.entry;
      const line = push(e.style.indent + 'require' + chunk.keywordGap + entryText(e));
      entries.push({ dep: e.dep, line, chunkIndex, inBlock: false });
      chunks.push({ kind: 'single', index: chunkIndex, openLine: line, closeLine: line, entryLines: [line] });
      return;
    }

    if (chunk.inline && chunk.entries.length === 0) {
      const line = push(chunk.open.indent + 'require' + chunk.open.gap + '()' + tail(chunk.open.trail, chunk.open.comment));
      chunks.push({ kind: 'block', index: chunkIndex, openLine: line, closeLine: line, entryLines: [] });
      return;
    }

    const openLine = push(chunk.open.indent + 'require' + chunk.open.gap + '(' + tail(chunk.open.trail, chunk.open.comment));
    const entryLines: number[] = [];
    chunk.entries.forEach((e, i) => {
      (chunk.innerBefore[i] ?? []).forEach(push);
      const line = push(e.style.indent + entryText(e));
      entryLines.push(line);
      entries.push({ dep: e.dep, line, chunkIndex, inBlock: true });
    });
    (chunk.innerBefore[chunk.entries.length] ?? []).forEach(push);
    const closeLine = push(chunk.close.indent + ')' + tail(chunk.close.trail, chunk.close.comment));
    chunks.push({ kind: 'block', index: chunkIndex, openLine, closeLine, entryLines });
  });

  layout.after.forEach(push);

  return {
    text: joinLines(lines, layout.format),
    lines,
    lineCount: lines.length,
    format: layout.format,
    dependencies: expectedDependencies(layout),
    entries,
    chunks,
  };
}

// ---------------------------------------------------------------------------
// Clean layouts
// ---------------------------------------------------------------------------

const cleanEntryArb: fc.Arbitrary<Entry> = validDependencyArb.map((dep) => ({
  dep,
  style: CLEAN_ENTRY_STYLE,
}));

const cleanChunkArb: fc.Arbitrary<Chunk> = fc.oneof(
  cleanEntryArb.map(
    (entry): Chunk => ({ kind: 'single', entry, keywordGap: ' ', before: [] }),
  ),
  fc.array(cleanEntryArb, { maxLength: 5 }).map(
    (entries): Chunk => ({
      kind: 'block',
      entries,
      before: [],
      open: { indent: '', gap: ' ', trail: '', comment: '' },
      close: { indent: '', trail: '', comment: '' },
      innerBefore: Array.from({ length: entries.length + 1 }, () => []),
      inline: false,
    }),
  ),
);

/** Clean layout: single-line requires and require blocks (0..n entries), no noise. */
export const layoutArb: fc.Arbitrary<Layout> = fc
  .array(cleanChunkArb, { maxLength: 6 })
  .map((chunks) => ({ chunks, after: [], format: CLEAN_FORMAT }));

/** The same dependencies in the same chunk structure with all noise removed. */
export function cleanLayout(layout: Layout): Layout {
  return {
    format: CLEAN_FORMAT,
    after: [],
    chunks: layout.chunks.map((c): Chunk =>
      c.kind === 'single'
        ? { kind: 'single', entry: { dep: c.entry.dep, style: CLEAN_ENTRY_STYLE }, keywordGap: ' ', before: [] }
        : {
            kind: 'block',
            entries: c.entries.map((e) => ({ dep: e.dep, style: CLEAN_ENTRY_STYLE })),
            before: [],
            open: { indent: '', gap: ' ', trail: '', comment: '' },
            close: { indent: '', trail: '', comment: '' },
            innerBefore: Array.from({ length: c.entries.length + 1 }, () => []),
            inline: false,
          },
    ),
  };
}

// ---------------------------------------------------------------------------
// Noise
// ---------------------------------------------------------------------------

const wsUnit = fc.constantFrom(' ', '\t');
const ws = (minLength: number) => fc.string({ unit: wsUnit, minLength, maxLength: 3 });
/** Whitespace that may be empty. */
const optWs = ws(0);
/** Whitespace of at least one space or tab. */
const reqWs = ws(1);

/** Comment body: any printable text, quotes included, never a line terminator. */
const commentTextArb = fc
  .string({ unit: fc.oneof(asciiUnit, fc.constantFrom(' ', '\t', '"', '`', "'"), bmpUnit, astralUnit), maxLength: 12 });

const commentArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 2, arbitrary: fc.constant('// indirect') },
  { weight: 2, arbitrary: commentTextArb.map((t) => '//' + t) },
);

const quoteStyleArb: fc.Arbitrary<QuoteStyle> = fc.constantFrom('none', 'none', 'double', 'raw');

const noisyEntryStyleArb: fc.Arbitrary<EntryStyle> = fc.record({
  indent: optWs,
  gap: reqWs,
  trail: optWs,
  comment: fc.oneof({ weight: 2, arbitrary: fc.constant('') }, { weight: 3, arbitrary: commentArb }),
  pathQuote: quoteStyleArb,
  versionQuote: quoteStyleArb,
});

const noisyEntryArb: fc.Arbitrary<Entry> = fc.record({ dep: validDependencyArb, style: noisyEntryStyleArb });

/** Blank line, whitespace-only line, or full-line comment. Safe inside any block. */
const trivialLineArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  reqWs,
  fc.tuple(optWs, commentArb).map(([i, c]) => i + c),
);

const blockNoiseArb: fc.Arbitrary<readonly string[]> = fc.array(trivialLineArb, { maxLength: 2 });

const verbArb = fc.constantFrom('replace', 'exclude', 'retract', 'tool', 'godebug', 'ignore');

/** Line inside a non-require block: a few tokens, never a lone `)`. */
const otherBlockBodyLineArb: fc.Arbitrary<string> = fc.oneof(
  trivialLineArb,
  fc
    .tuple(optWs, fc.array(noCloseParenTokenArb, { minLength: 1, maxLength: 4 }), fc.constantFrom(' ', '\t'), optWs)
    .map(([i, toks, sep, t]) => i + toks.join(sep) + t),
  fc.tuple(noCloseParenTokenArb, noCloseParenTokenArb, noCloseParenTokenArb).map(
    ([a, b, c]) => `\t${a} => ${b} ${c}`,
  ),
  fc.tuple(noCloseParenTokenArb, validTokenArb).map(([p, v]) => `\t${p} ${v} // indirect`),
);

/** `<verb> (` ... `)` as separate physical lines. */
const otherBlockArb: fc.Arbitrary<readonly string[]> = fc
  .tuple(verbArb, fc.array(otherBlockBodyLineArb, { maxLength: 3 }), optWs, fc.option(commentArb, { nil: '' }))
  .map(([verb, body, closeIndent, closeComment]) => [
    `${verb} (`,
    ...body,
    closeIndent + ')' + (closeComment === '' ? '' : ' ' + closeComment),
  ]);

/** Single-line non-require directives (`module`, `package`, `go`, `toolchain`, ...). */
const directiveLineArb: fc.Arbitrary<readonly string[]> = fc
  .tuple(
    fc.oneof(
      modulePathArb.map((p) => `module ${p}`),
      noOpenParenTokenArb.map((p) => `module ${p}`),
      noOpenParenTokenArb.map((p) => `package ${p}`),
      fc.constantFrom('go 1.21', 'go 1.22.1', 'toolchain go1.22.1', 'godebug default=go1.21'),
      fc.tuple(noOpenParenTokenArb, noOpenParenTokenArb).map(([a, b]) => `replace ${a} => ${b}`),
      fc.tuple(noOpenParenTokenArb, validTokenArb, noOpenParenTokenArb, validTokenArb).map(
        ([a, v, b, w]) => `replace ${a} ${v} => ${b} ${w}`,
      ),
      fc.tuple(validTokenArb, validTokenArb).map(([a, v]) => `exclude ${a} ${v}`),
      noOpenParenTokenArb.map((v) => `retract ${v}`),
      fc.tuple(validTokenArb, validTokenArb).map(([a, b]) => `retract [${a}, ${b}]`),
    ),
    optWs,
    fc.option(commentArb, { nil: '' }),
  )
  .map(([directive, t, comment]) => [directive + tail(t, comment)]);

/** Noise lines allowed between top-level chunks. */
const topNoiseArb: fc.Arbitrary<readonly string[]> = fc
  .array(
    fc.oneof(
      { weight: 3, arbitrary: trivialLineArb.map((l) => [l] as readonly string[]) },
      { weight: 2, arbitrary: directiveLineArb },
      { weight: 1, arbitrary: otherBlockArb },
    ),
    { maxLength: 3 },
  )
  .map((groups) => groups.flat());

const noisyChunkArb: fc.Arbitrary<Chunk> = fc.oneof(
  fc.record({
    kind: fc.constant('single' as const),
    entry: noisyEntryArb,
    keywordGap: reqWs,
    before: topNoiseArb,
  }),
  fc
    .array(noisyEntryArb, { maxLength: 5 })
    .chain((entries) =>
      fc.record({
        kind: fc.constant('block' as const),
        entries: fc.constant(entries),
        before: topNoiseArb,
        open: fc.record({
          indent: optWs,
          gap: reqWs,
          trail: optWs,
          comment: fc.oneof(fc.constant(''), commentArb),
        }),
        close: fc.record({ indent: optWs, trail: optWs, comment: fc.oneof(fc.constant(''), commentArb) }),
        innerBefore: fc.array(blockNoiseArb, {
          minLength: entries.length + 1,
          maxLength: entries.length + 1,
        }),
        inline: fc.boolean(),
      }),
    ),
);

const noisyFormatArb: fc.Arbitrary<LayoutFormat> = fc.record({
  eol: fc.constantFrom('\n' as const, '\r\n' as const),
  bom: fc.boolean(),
  finalNewline: fc.boolean(),
});

/**
 * Layout decorated with presentation noise. `cleanLayout(layout)` has the same
 * dependencies, so parsing both renderings must give the same result.
 * Noise lines (comments, blanks, directives, non-require blocks) can also trail the last chunk.
 */
export const noisyLayoutArb: fc.Arbitrary<Layout> = fc
    .tuple(fc.array(noisyChunkArb, { maxLength: 6 }), topNoiseArb, noisyFormatArb)
  .map(([chunks, after, format]) => ({
    format,
    after,
    chunks: chunks.map((c): Chunk =>
      // Inline form is only legal for empty blocks.
      c.kind === 'block' && c.entries.length > 0 ? { ...c, inline: false } : c,
    ),
  }));

// ---------------------------------------------------------------------------
// Defect lines (for Property 3)
// ---------------------------------------------------------------------------

/**
 * Appending this as a new line gives an unclosed require block that starts at that line,
 * provided the text before it has no unclosed block.
 */
export const UNCLOSED_REQUIRE_LINE = 'require (';

/**
 * Top-level `require` line with zero or one token after `require`.
 * Never `require (` (opens a block) nor `require ()` (empty block).
 */
export const missingTokenTopLevelLineArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant('require'),
  fc
    .tuple(validTokenArb.filter((t) => t !== '(' && t !== '()'), reqWs)
    .map(([tok, gap]) => 'require' + gap + tok),
);

/** Line inside a require block with exactly one token that is not `)` (which would close the block). */
export const missingTokenBlockLineArb: fc.Arbitrary<string> = fc
  .tuple(optWs, noCloseParenTokenArb)
  .map(([indent, tok]) => indent + tok);

// ---------------------------------------------------------------------------
// Installed-view snapshots (src/core/installedModel.ts)
// ---------------------------------------------------------------------------
//
// Choices worth knowing about when writing properties on top of these generators:
//
//  - Parse-error line numbers. `GoModParseError.line` is a required `number` (1-based), so the
//    model never sees `undefined` there and `messages.parseError(path, undefined, msg)` (the
//    "no line" form) is unreachable through a snapshot. The src type is intentionally not changed.
//    "Without a line number" is therefore modelled as the sentinel line `0` (which can never come
//    from the parser, whose lines are 1-based). Properties must compute expected text with
//    `messages.parseError(goModPath, error.line, error.message)`, which renders `line 0: ...`
//    for the sentinel; they must not assume the line segment is omitted.
//  - Unique folder URIs. Every snapshot has pairwise-distinct `folderUri` values, but folder names
//    and module paths are drawn from small pools, so labels collide on purpose (a module path of
//    one folder equals the folder name of another, two folders share a name, ...). This exercises
//    the group-label tiebreak on `folderUri`.
//  - Package paths include astral characters, BMP characters above the surrogate range
//    (U+E000..U+FFFF, which sort differently under UTF-16 code units than under code points),
//    prefixes of one another, and duplicate paths (same or different version).
//  - `modulePath` is only present on `parsed` states, and is omitted entirely (not set to
//    `undefined`) when absent. `parseError` states never carry one.

/** Kinds of per-folder state. */
export type FolderStateKind = FolderGoModState['kind'];
export type PresentFolderStateKind = Exclude<FolderStateKind, 'absent'>;

/** Strings that collide often and that stress code point ordering (astral vs. high BMP vs. ASCII). */
const COLLISION_NAMES: readonly string[] = [
  'a',
  'ab',
  'a/b',
  'app',
  'Z',
  'café',
  '\uE000',
  '\uFF5E',
  '\uFFFD',
  '\u{1F600}',
  '\u{10000}x',
  'x\u{1F680}',
];

const collisionNameArb: fc.Arbitrary<string> = fc.constantFrom(...COLLISION_NAMES);

/** Folder display name: mostly drawn from the collision pool, sometimes free-form (incl. astral). */
const folderNameArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: collisionNameArb },
  { weight: 1, arbitrary: validTokenArb },
);

/** Optional module path (`undefined` means: leave the property out). May equal a folder name. */
const optionalModulePathArb: fc.Arbitrary<string | undefined> = fc.oneof(
  { weight: 2, arbitrary: fc.constant(undefined) },
  { weight: 2, arbitrary: modulePathArb },
  { weight: 2, arbitrary: collisionNameArb },
  { weight: 1, arbitrary: validTokenArb },
);

/** Dependency path for snapshot packages: collision/tricky paths, realistic paths, arbitrary tokens. */
const snapshotPathArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: collisionNameArb },
  { weight: 2, arbitrary: modulePathArb },
  { weight: 2, arbitrary: validTokenArb },
);

const snapshotDependencyArb: fc.Arbitrary<PackageDependency> = fc.record({
  path: snapshotPathArb,
  version: fc.oneof({ weight: 1, arbitrary: versionArb }, { weight: 1, arbitrary: validTokenArb }),
});

/**
 * Dependency list of a parsed go.mod file: 0..6 entries, with extra copies of existing paths
 * (same version or a different one) so duplicates are common.
 */
export const snapshotDependenciesArb: fc.Arbitrary<readonly PackageDependency[]> = fc
  .array(snapshotDependencyArb, { maxLength: 6 })
  .chain((deps) =>
    deps.length === 0
      ? fc.constant<readonly PackageDependency[]>(deps)
      : fc
          .array(
            fc.record({
              from: fc.nat(deps.length - 1),
              sameVersion: fc.boolean(),
              version: versionArb,
            }),
            { maxLength: 3 },
          )
          .chain((dups) =>
            fc
              .array(fc.nat(), { minLength: dups.length, maxLength: dups.length })
              .map((positions): readonly PackageDependency[] => {
                const out = [...deps];
                dups.forEach((d, i) => {
                  const src = deps[d.from]!;
                  const copy = { path: src.path, version: d.sameVersion ? src.version : d.version };
                  out.splice((positions[i] ?? 0) % (out.length + 1), 0, copy);
                });
                return out;
              }),
          ),
  );

/**
 * Parse error. About one in five has the "no line" sentinel `0`; the rest are 1-based lines.
 * See the section comment for why `0` stands in for "without a line number".
 */
export const goModParseErrorArb: fc.Arbitrary<GoModParseError> = fc.record({
  line: fc.oneof({ weight: 4, arbitrary: fc.integer({ min: 1, max: 100000 }) }, { weight: 1, arbitrary: fc.constant(0) }),
  message: fc.oneof(
    fc.constantFrom(
      'unexpected end of file',
      'require directive requires a path and a version',
      'unterminated quoted string',
      'unclosed require block',
    ),
    fc.string({ unit: fc.oneof(asciiUnit, fc.constantFrom(' ', ':'), bmpUnit, astralUnit), minLength: 1, maxLength: 20 }),
  ),
});

/** Read-failure reason, e.g. an OS error text, sometimes with non-ASCII characters. */
export const readErrorReasonArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom('EACCES: permission denied', 'EISDIR: illegal operation on a directory', 'file is not valid UTF-8'),
  fc.string({ unit: fc.oneof(asciiUnit, fc.constantFrom(' ', ':'), bmpUnit, astralUnit), minLength: 1, maxLength: 20 }),
);

/** Identity of one workspace folder; `folderUri` is supplied by the caller so snapshots stay unique. */
interface FolderIdentity {
  readonly folderUri: string;
  readonly folderName: string;
  readonly goModPath: string;
}

const folderUriSegmentArb: fc.Arbitrary<string> = fc.oneof(
  { weight: 3, arbitrary: collisionNameArb },
  { weight: 1, arbitrary: fc.stringMatching(/^[a-z0-9]{1,6}$/) },
);

/** Folder URI (not unique by itself; `folderUrisArb` makes sets of them unique). */
const folderUriArb: fc.Arbitrary<string> = folderUriSegmentArb.map((s) => `file:///ws/${s}`);

/** `n` pairwise-distinct folder URIs. Short collision-pool segments make near-duplicates common. */
function folderUrisArb(n: number): fc.Arbitrary<string[]> {
  return fc.uniqueArray(folderUriArb, { minLength: n, maxLength: n });
}

function identityArb(folderUri: string): fc.Arbitrary<FolderIdentity> {
  return folderNameArb.map((folderName) => ({ folderUri, folderName, goModPath: `${folderUri}/go.mod` }));
}

/** State of the given kind for the given (caller-chosen, unique) folder URI. */
export function folderStateOfKindArb(kind: FolderStateKind, folderUri: string): fc.Arbitrary<FolderGoModState> {
  return identityArb(folderUri).chain((id): fc.Arbitrary<FolderGoModState> => {
    switch (kind) {
      case 'absent':
        return fc.constant({ kind, folderUri: id.folderUri, folderName: id.folderName });
      case 'parsed':
        return fc
          .tuple(optionalModulePathArb, snapshotDependenciesArb)
          .map(([modulePath, dependencies]) => ({
            kind,
            ...id,
            ...(modulePath === undefined ? {} : { modulePath }),
            dependencies,
          }));
      case 'parseError':
        return goModParseErrorArb.map((error) => ({ kind, ...id, error }));
      case 'readError':
        return readErrorReasonArb.map((reason) => ({ kind, ...id, reason }));
    }
  });
}

const stateKindArb: fc.Arbitrary<FolderStateKind> = fc.constantFrom<FolderStateKind>(
  'absent',
  'parsed',
  'parseError',
  'readError',
);
const presentKindArb: fc.Arbitrary<PresentFolderStateKind> = fc.constantFrom<PresentFolderStateKind>(
  'parsed',
  'parsed',
  'parseError',
  'readError',
);

/** Any single folder state with the URI `file:///ws/<segment>`. */
export const folderStateArb: fc.Arbitrary<FolderGoModState> = folderUriArb.chain((uri) =>
  stateKindArb.chain((kind) => folderStateOfKindArb(kind, uri)),
);

/** Snapshot whose folders have the given kinds (in order) and pairwise-unique URIs. */
function snapshotOfKindsArb(kinds: readonly FolderStateKind[]): fc.Arbitrary<InstalledSnapshot> {
  return folderUrisArb(kinds.length).chain((uris) =>
    fc
      .tuple(...kinds.map((k, i) => folderStateOfKindArb(k, uris[i]!)))
      .map((folders): InstalledSnapshot => ({ folders })),
  );
}

/** Puts `items` into a random order (stable on ties, shrinks towards the original order). */
function shuffledArb<T>(items: readonly T[]): fc.Arbitrary<T[]> {
  return fc
    .array(fc.nat(1000), { minLength: items.length, maxLength: items.length })
    .map((keys) =>
      items
        .map((item, i) => ({ item, key: keys[i]!, i }))
        .sort((a, b) => a.key - b.key || a.i - b.i)
        .map((x) => x.item),
    );
}

/** Kind lists with `present` present entries (random kinds) and `absent` absent ones, shuffled. */
function kindsArb(
  present: fc.Arbitrary<number>,
  absent: fc.Arbitrary<number>,
): fc.Arbitrary<FolderStateKind[]> {
  return fc
    .tuple(present, absent)
    .chain(([p, a]) =>
      fc
        .array(presentKindArb, { minLength: p, maxLength: p })
        .chain((pk) => shuffledArb<FolderStateKind>([...pk, ...Array<FolderStateKind>(a).fill('absent')])),
    );
}

/** Snapshot with 0..6 folders of any state. */
export const snapshotArb: fc.Arbitrary<InstalledSnapshot> = fc
  .array(stateKindArb, { maxLength: 6 })
  .chain(snapshotOfKindsArb);

/** Snapshot with no workspace folders at all. */
export const snapshotNoFoldersArb: fc.Arbitrary<InstalledSnapshot> = fc.constant({ folders: [] });

/** Snapshot with 1..5 folders, none of which has a go.mod (all `absent`). */
export const snapshotNoPresentArb: fc.Arbitrary<InstalledSnapshot> = fc
  .integer({ min: 1, max: 5 })
  .chain((n) => snapshotOfKindsArb(Array<FolderStateKind>(n).fill('absent')));

/** Snapshot with exactly one present go.mod (any present kind) among 0..4 absent folders. */
export const snapshotOnePresentArb: fc.Arbitrary<InstalledSnapshot> = kindsArb(
  fc.constant(1),
  fc.integer({ min: 0, max: 4 }),
).chain(snapshotOfKindsArb);

/** Snapshot with at least `min` (default 2) and at most 5 present go.mod files, plus 0..3 absent folders. */
export function snapshotManyPresentArb(min = 2): fc.Arbitrary<InstalledSnapshot> {
  return kindsArb(fc.integer({ min, max: Math.max(min, 5) }), fc.integer({ min: 0, max: 3 })).chain(
    snapshotOfKindsArb,
  );
}

/** Snapshot with at least 2 present go.mod files (multi-root, grouped display). */
export const snapshotMultiPresentArb: fc.Arbitrary<InstalledSnapshot> = snapshotManyPresentArb(2);

/** A snapshot and the index (into `folders`) of one of its present (non-absent) files. */
export interface SnapshotWithTarget {
  readonly snapshot: InstalledSnapshot;
  /** Index into `snapshot.folders`; `snapshot.folders[index].kind !== 'absent'`. */
  readonly index: number;
}

/**
 * Snapshot with at least `minPresent` present files (default 1) and the index of one present file,
 * e.g. to replace that file's state with an error state (Property 12 uses `minPresent = 2`).
 */
export function snapshotWithTargetArb(minPresent = 1): fc.Arbitrary<SnapshotWithTarget> {
  return snapshotManyPresentArb(minPresent).chain((snapshot) => {
    const presentIdx = snapshot.folders.flatMap((f, i) => (f.kind === 'absent' ? [] : [i]));
    return fc
      .constantFrom(...presentIdx)
      .map((index): SnapshotWithTarget => ({ snapshot, index }));
  });
}

/** An error state (parseError or readError) for the same folder as `base`: same URI, name and go.mod path. */
export function errorReplacementArb(base: FolderGoModState): fc.Arbitrary<FolderGoModState> {
  const goModPath = base.kind === 'absent' ? `${base.folderUri}/go.mod` : base.goModPath;
  const id = { folderUri: base.folderUri, folderName: base.folderName, goModPath };
  return fc.oneof(
    goModParseErrorArb.map((error): FolderGoModState => ({ kind: 'parseError', ...id, error })),
    readErrorReasonArb.map((reason): FolderGoModState => ({ kind: 'readError', ...id, reason })),
  );
}

/** Original snapshot, the mutated target index, the replacement state, and the mutated snapshot. */
export interface SnapshotErrorMutation extends SnapshotWithTarget {
  readonly replacement: FolderGoModState;
  /** `snapshot` with `folders[index]` replaced by `replacement`; all other folders are the same objects. */
  readonly mutated: InstalledSnapshot;
}

/** Snapshot with `minPresent` (default 2) present files, one of which is turned into an error state. */
export function snapshotWithErrorMutationArb(minPresent = 2): fc.Arbitrary<SnapshotErrorMutation> {
  return snapshotWithTargetArb(minPresent).chain(({ snapshot, index }) =>
    errorReplacementArb(snapshot.folders[index]!).map((replacement) => ({
      snapshot,
      index,
      replacement,
      mutated: { folders: snapshot.folders.map((f, i) => (i === index ? replacement : f)) },
    })),
  );
}
