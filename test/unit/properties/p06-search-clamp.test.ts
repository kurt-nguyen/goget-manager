import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { clampSearchText } from '../../../src/core/searchText';

const LIMIT = 256;
const RUNS = 200;

const codePointCount = (s: string): number => Array.from(s).length;
const isHighSurrogate = (unit: number): boolean => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number): boolean => unit >= 0xdc00 && unit <= 0xdfff;

// A single code point as a string: BMP (non-surrogate), astral, or a lone surrogate.
const bmpUnit = fc
  .integer({ min: 0, max: 0xffff })
  .filter((cp) => cp < 0xd800 || cp > 0xdfff)
  .map((cp) => String.fromCodePoint(cp));
const astralUnit = fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp));
const loneSurrogateUnit = fc.integer({ min: 0xd800, max: 0xdfff }).map((cp) => String.fromCharCode(cp));
const asciiUnit = fc.integer({ min: 0x20, max: 0x7e }).map((cp) => String.fromCharCode(cp));

// Strings around and well beyond the 256 code point limit, heavy on astral characters.
const longMixed = fc.string({
  unit: fc.oneof(
    { weight: 3, arbitrary: astralUnit },
    { weight: 2, arbitrary: asciiUnit },
    { weight: 1, arbitrary: bmpUnit },
    { weight: 1, arbitrary: loneSurrogateUnit },
  ),
  minLength: 200,
  maxLength: 600,
});

const allAstralNearLimit = fc.string({ unit: astralUnit, minLength: 250, maxLength: 262 });
const shortMixed = fc.string({ unit: fc.oneof(astralUnit, asciiUnit, bmpUnit), maxLength: 300 });

// Raw UTF-16 code units, including unpaired surrogates and accidental pairs.
const rawUnits = fc.string({
  unit: fc.integer({ min: 0xd800, max: 0xdfff }).map((u) => String.fromCharCode(u)),
  maxLength: 700,
});

const anyString = fc.oneof(longMixed, allAstralNearLimit, shortMixed, rawUnits);

describe('Property 6', () => {
  // Feature: goget-manager-extension, Property 6: Search text clamping keeps the first 256 characters
  // **Validates: Requirements 3.3, 3.6**
  it('clamps to a prefix of at most 256 code points without splitting a surrogate pair', () => {
    fc.assert(
      fc.property(anyString, (s) => {
        const result = clampSearchText(s);

        // Prefix of the input.
        expect(s.startsWith(result)).toBe(true);

        // At most 256 code points.
        expect(codePointCount(result)).toBeLessThanOrEqual(LIMIT);

        if (codePointCount(s) <= LIMIT) {
          // Unchanged when within the limit.
          expect(result).toBe(s);
        } else {
          // Exactly the first 256 code points otherwise.
          expect(result).toBe(Array.from(s).slice(0, LIMIT).join(''));
          expect(codePointCount(result)).toBe(LIMIT);

          // Truncation must not leave a high surrogate whose low surrogate was cut off.
          const last = result.charCodeAt(result.length - 1);
          const next = s.charCodeAt(result.length);
          expect(isHighSurrogate(last) && isLowSurrogate(next)).toBe(false);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it('keeps exactly 256 astral characters from a longer astral-only string', () => {
    const s = '😀'.repeat(300);
    const result = clampSearchText(s);
    expect(result).toBe('😀'.repeat(256));
    expect(result.length).toBe(512);
  });

  it('returns strings of exactly 256 code points unchanged', () => {
    const s = '😀'.repeat(255) + 'a';
    expect(clampSearchText(s)).toBe(s);
  });
});
