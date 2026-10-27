import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { buildSearchUrl, encodeQueryComponent } from '../../../src/core/searchQuery';

const RUNS = 200;
const ENCODED_PATTERN = /^([A-Za-z0-9\-._~]|%[0-9A-F]{2})*$/;
const UNRESERVED = /^[A-Za-z0-9\-._~]$/;

const hex = (b: number): string => '%' + b.toString(16).toUpperCase().padStart(2, '0');

// Reference encoder: one code point at a time, so it is independent of the byte-wise implementation.
const referenceEncode = (s: string): string =>
  Array.from(s)
    .map((ch) => (UNRESERVED.test(ch) ? ch : Array.from(new TextEncoder().encode(ch)).map(hex).join('')))
    .join('');

// A lone surrogate shows up as a single UTF-16 unit when iterating by code point.
const isLoneSurrogate = (ch: string): boolean => {
  const unit = ch.charCodeAt(0);
  return ch.length === 1 && unit >= 0xd800 && unit <= 0xdfff;
};
const toWellFormedString = (s: string): string =>
  Array.from(s)
    .map((ch) => (isLoneSurrogate(ch) ? '\ufffd' : ch))
    .join('');

const unreservedUnit = fc.constantFrom(...'ABCXYZabcxyz0189-._~'.split(''));
const reservedUnit = fc.constantFrom(...' &=#+%?/:;@$,!\'()*[]"<>\\^`{|}\t\n'.split(''));
const bmpUnit = fc
  .integer({ min: 0x80, max: 0xffff })
  .filter((cp) => cp < 0xd800 || cp > 0xdfff)
  .map((cp) => String.fromCodePoint(cp));
const astralUnit = fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp));
const loneSurrogateUnit = fc.integer({ min: 0xd800, max: 0xdfff }).map((cp) => String.fromCharCode(cp));

const wellFormedUnit = fc.oneof(
  { weight: 4, arbitrary: unreservedUnit },
  { weight: 4, arbitrary: reservedUnit },
  { weight: 2, arbitrary: bmpUnit },
  { weight: 2, arbitrary: astralUnit },
);
const wellFormed = fc.string({ unit: wellFormedUnit, maxLength: 300 });

// Any UTF-16 sequence, including unpaired and mis-ordered surrogates.
const anyUnit = fc.oneof(wellFormedUnit, loneSurrogateUnit);
const anyString = fc.string({ unit: anyUnit, maxLength: 300 });

describe('Property 2', () => {
  // Feature: search-packages, Property 2: Query encoding uses only unreserved characters and uppercase UTF-8 escapes
  // **Validates: Requirements 2.2**
  it('emits only unreserved characters and uppercase %XX escapes of the UTF-8 bytes', () => {
    fc.assert(
      fc.property(wellFormed, (s) => {
        const encoded = encodeQueryComponent(s);

        expect(encoded).toMatch(ENCODED_PATTERN);
        expect(encoded).toBe(referenceEncode(s));

        // Unreserved characters stay literal: dropping them from the input and
        // the output removes the same number of characters.
        const unreservedCount = Array.from(s).filter((ch) => UNRESERVED.test(ch)).length;
        expect(encoded.replace(/%[0-9A-F]{2}/g, '').length).toBe(unreservedCount);

        // Escapes decode back to the original text.
        expect(decodeURIComponent(encoded)).toBe(s);
      }),
      { numRuns: RUNS },
    );
  });

  it('replaces lone surrogates with U+FFFD (%EF%BF%BD) and still emits only allowed characters', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const encoded = encodeQueryComponent(s);
        expect(encoded).toMatch(ENCODED_PATTERN);
        expect(encoded).toBe(referenceEncode(toWellFormedString(s)));
      }),
      { numRuns: RUNS },
    );
  });

  it('places the encoded query between the fixed search prefix and suffix', () => {
    fc.assert(
      fc.property(wellFormed.filter((s) => s !== ''), (s) => {
        const result = buildSearchUrl(s);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.url).toBe(`https://pkg.go.dev/search?q=${encodeQueryComponent(s)}&m=package`);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('writes space as %20, plus as %2B, and a lone surrogate as %EF%BF%BD', () => {
    expect(encodeQueryComponent(' ')).toBe('%20');
    expect(encodeQueryComponent('+')).toBe('%2B');
    expect(encodeQueryComponent('\ud800')).toBe('%EF%BF%BD');
    expect(encodeQueryComponent('a\udc00b')).toBe('a%EF%BF%BDb');
    expect(encodeQueryComponent('\ud83d\ude00')).toBe('%F0%9F%98%80');
  });
});
