import { clampSearchText } from './searchText';

export const PKG_GO_DEV_HOST = 'pkg.go.dev';

const SEARCH_URL_PREFIX = `https://${PKG_GO_DEV_HOST}/search?q=`;
const SEARCH_URL_SUFFIX = '&m=package';
const PACKAGE_URL_PREFIX = `https://${PKG_GO_DEV_HOST}/`;
const HEX = '0123456789ABCDEF';

export type SearchUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'empty' };

export type PackageUrlResult =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly reason: 'emptyPath' | 'notPkgGoDev' };

/** Search_Query: Search_Box text clamped to 256 code points, then trimmed. */
export function toSearchQuery(text: string): string {
  return clampSearchText(text).trim();
}

function replaceLoneSurrogates(value: string): string {
  let out = '';
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : 0;
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value.slice(i, i + 2);
        i++;
      } else {
        out += '\ufffd';
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += '\ufffd';
    } else {
      out += value.charAt(i);
    }
  }
  return out;
}

function isUnreservedByte(b: number): boolean {
  return (
    (b >= 0x41 && b <= 0x5a) || // A-Z
    (b >= 0x61 && b <= 0x7a) || // a-z
    (b >= 0x30 && b <= 0x39) || // 0-9
    b === 0x2d || // -
    b === 0x2e || // .
    b === 0x5f || // _
    b === 0x7e // ~
  );
}

/**
 * RFC 3986 encoding of a query component. Only `A-Z a-z 0-9 - . _ ~` stay
 * literal; every other UTF-8 byte is written as `%` + two uppercase hex digits.
 * Lone surrogates are replaced with U+FFFD first.
 */
export function encodeQueryComponent(value: string): string {
  const bytes = new TextEncoder().encode(replaceLoneSurrogates(value));
  let out = '';
  for (const b of bytes) {
    out += isUnreservedByte(b) ? String.fromCharCode(b) : '%' + HEX.charAt(b >> 4) + HEX.charAt(b & 0x0f);
  }
  return out;
}

/** `https://pkg.go.dev/search?q=<encoded>&m=package`, or `{ ok: false, reason: 'empty' }`. */
export function buildSearchUrl(query: string): SearchUrlResult {
  if (query === '') {
    return { ok: false, reason: 'empty' };
  }
  return { ok: true, url: SEARCH_URL_PREFIX + encodeQueryComponent(query) + SEARCH_URL_SUFFIX };
}

/**
 * True iff `url` parses as a WHATWG URL with protocol `https:`, hostname
 * `pkg.go.dev`, port empty or 443, and no username or password. Never throws.
 */
export function isPkgGoDevHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname === PKG_GO_DEV_HOST &&
      (parsed.port === '' || parsed.port === '443') &&
      parsed.username === '' &&
      parsed.password === ''
    );
  } catch {
    return false;
  }
}

/** `https://pkg.go.dev/<path>` checked with `isPkgGoDevHttpsUrl`. */
export function packagePageUrl(path: string): PackageUrlResult {
  if (path === '') {
    return { ok: false, reason: 'emptyPath' };
  }
  const url = PACKAGE_URL_PREFIX + path;
  if (!isPkgGoDevHttpsUrl(url)) {
    return { ok: false, reason: 'notPkgGoDev' };
  }
  return { ok: true, url };
}
