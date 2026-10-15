/**
 * Pure go.mod parser. No `vscode` import.
 *
 * Extracts `require` dependencies (single-line and block form) in file order,
 * ignores every other directive, and reports the first malformed line.
 */

export interface PackageDependency {
  readonly path: string;
  readonly version: string;
}

export interface GoModParseError {
  /** 1-based line number of the defect. */
  readonly line: number;
  readonly message: string;
}

export interface ParseSuccess {
  readonly ok: true;
  /** From the first `module` or `package` directive, if any. */
  readonly modulePath?: string;
  readonly dependencies: readonly PackageDependency[];
}

export interface ParseFailure {
  readonly ok: false;
  readonly error: GoModParseError;
}

export type ParseResult = ParseSuccess | ParseFailure;

interface Token {
  /** Token value without enclosing quotes. */
  readonly value: string;
  /** True when the token was written as a "..." or `...` string. */
  readonly quoted: boolean;
}

type LineTokens = { readonly tokens: Token[] } | { readonly error: string };

const MSG_MISSING = 'require entry is missing a package path or version';
const MSG_UNEXPECTED = 'unexpected token in require entry';
const MSG_UNTERMINATED = 'unterminated quoted string';
const MSG_UNCLOSED = 'unclosed require block';

/** Splits one line (without its line terminator) into tokens, dropping comments. */
function tokenizeLine(line: string): LineTokens {
  const tokens: Token[] = [];
  const n = line.length;
  let i = 0;

  while (i < n) {
    const ch = line[i];

    if (ch === ' ' || ch === '\t') {
      i++;
      continue;
    }

    if (ch === '/' && line[i + 1] === '/') {
      break; // comment runs to end of line
    }

    if (ch === '"') {
      let value = '';
      let j = i + 1;
      let closed = false;
      while (j < n) {
        const c = line[j];
        if (c === '\\' && j + 1 < n) {
          const next = line[j + 1];
          if (next === '"' || next === '\\') {
            value += next;
          } else {
            value += c + next; // unknown escapes are kept verbatim
          }
          j += 2;
          continue;
        }
        if (c === '"') {
          closed = true;
          j++;
          break;
        }
        value += c;
        j++;
      }
      if (!closed) {
        return { error: MSG_UNTERMINATED };
      }
      tokens.push({ value, quoted: true });
      i = j;
      continue;
    }

    if (ch === '`') {
      const end = line.indexOf('`', i + 1);
      if (end === -1) {
        return { error: MSG_UNTERMINATED };
      }
      tokens.push({ value: line.slice(i + 1, end), quoted: true });
      i = end + 1;
      continue;
    }

    let j = i;
    while (j < n && line[j] !== ' ' && line[j] !== '\t') {
      j++;
    }
    tokens.push({ value: line.slice(i, j), quoted: false });
    i = j;
  }

  return { tokens };
}

function isPunct(token: Token | undefined, value: string): boolean {
  return token !== undefined && !token.quoted && token.value === value;
}

function isVerb(token: Token | undefined, value: string): boolean {
  return isPunct(token, value);
}

type State = 'top' | 'require' | 'other';

export function parseGoMod(text: string): ParseResult {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = source.split('\n');

  const dependencies: PackageDependency[] = [];
  let modulePath: string | undefined;
  let state: State = 'top';
  let requireOpenLine = 0;

  const fail = (line: number, message: string): ParseFailure => ({
    ok: false,
    error: { line, message },
  });

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    let raw = lines[idx] ?? '';
    if (raw.endsWith('\r')) {
      raw = raw.slice(0, -1);
    }

    const lexed = tokenizeLine(raw);
    if ('error' in lexed) {
      return fail(lineNo, lexed.error);
    }
    const tokens = lexed.tokens;
    if (tokens.length === 0) {
      continue;
    }

    if (state === 'other') {
      if (tokens.length === 1 && isPunct(tokens[0], ')')) {
        state = 'top';
      }
      continue;
    }

    if (state === 'require') {
      if (tokens.length === 1) {
        if (isPunct(tokens[0], ')')) {
          state = 'top';
          continue;
        }
        return fail(lineNo, MSG_MISSING);
      }
      if (tokens.length > 2) {
        return fail(lineNo, MSG_UNEXPECTED);
      }
      const [first, second] = tokens as [Token, Token];
      dependencies.push({ path: first.value, version: second.value });
      continue;
    }

    // Top level
    const head = tokens[0];
    const arg1 = tokens[1];
    const arg2 = tokens[2];

    if (isVerb(head, 'require')) {
      if (tokens.length === 2 && isPunct(tokens[1], '(')) {
        state = 'require';
        requireOpenLine = lineNo;
        continue;
      }
      if (tokens.length === 2 && isPunct(tokens[1], '()')) {
        continue; // empty block on one line
      }
      if (tokens.length < 3) {
        return fail(lineNo, MSG_MISSING);
      }
      if (tokens.length > 3) {
        return fail(lineNo, MSG_UNEXPECTED);
      }
      dependencies.push({ path: (arg1 as Token).value, version: (arg2 as Token).value });
      continue;
    }

    if (tokens.length === 2 && isPunct(tokens[1], '(')) {
      state = 'other';
      continue;
    }

    if ((isVerb(head, 'module') || isVerb(head, 'package')) && tokens.length >= 2) {
      if (modulePath === undefined) {
        modulePath = (arg1 as Token).value;
      }
    }
    // Every other directive is ignored.
  }

  if (state === 'require') {
    return fail(requireOpenLine, MSG_UNCLOSED);
  }

  return modulePath === undefined
    ? { ok: true, dependencies }
    : { ok: true, modulePath, dependencies };
}
