import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { compareCodePoints } from '../../../src/core/compare';

// Feature: goget-manager-extension, Property 7: Code point comparator matches a reference ordering
// **Validates: Requirements 5.4**

/**
 * Small alphabet that stresses the UTF-16 vs. code point difference:
 * ASCII, BMP characters above the surrogate range (U+E000, U+FF5E, U+FFFF),
 * and astral-plane characters (U+10000, emoji, U+10FFFF). Small on purpose so
 * generated strings often share prefixes and collide.
 */
const unit = fc.oneof(
  fc.constantFrom('a', 'b', 'Z', '0', '/', '.', '\u00e9', '\u4e2d', '\ue000', '\uff5e', '\uffff'),
  fc.constantFrom('\u{10000}', '\u{1f600}', '\u{1f680}', '\u{20000}', '\u{10ffff}'),
  fc.integer({ min: 0x10000, max: 0x10ffff }).map((cp) => String.fromCodePoint(cp)),
  fc.integer({ min: 0x20, max: 0x7e }).map((cp) => String.fromCodePoint(cp)),
);

const text = fc.array(unit, { maxLength: 8 }).map((units) => units.join(''));

/** Pairs where `b` is often derived from `a` (equal, prefix, or extension). */
const textPair = fc.oneof(
  fc.tuple(text, text),
  text.map((a) => [a, a] as [string, string]),
  fc.tuple(text, text).map(([a, extra]) => [a, a + extra] as [string, string]),
  fc.tuple(text, text, text).map(([p, x, y]) => [p + x, p + y] as [string, string]),
);

/** Reference ordering: lexicographic comparison of code point arrays. */
function referenceSign(a: string, b: string): number {
  const ca = Array.from(a, (c) => c.codePointAt(0)!);
  const cb = Array.from(b, (c) => c.codePointAt(0)!);
  const n = Math.min(ca.length, cb.length);
  for (let i = 0; i < n; i++) {
    if (ca[i] !== cb[i]) {
      return ca[i]! < cb[i]! ? -1 : 1;
    }
  }
  return Math.sign(ca.length - cb.length);
}

describe('Property 7: Code point comparator matches a reference ordering', () => {
  it('has the same sign as lexicographic comparison of code point arrays', () => {
    fc.assert(
      fc.property(textPair, ([a, b]) => {
        expect(Math.sign(compareCodePoints(a, b))).toBe(referenceSign(a, b));
      }),
      { numRuns: 300 },
    );
  });

  it('returns 0 if and only if the strings are identical', () => {
    fc.assert(
      fc.property(textPair, ([a, b]) => {
        expect(compareCodePoints(a, b) === 0).toBe(a === b);
      }),
      { numRuns: 300 },
    );
  });

  it('orders astral-plane characters after BMP characters above the surrogate range', () => {
    // UTF-16 code unit order would put U+10000 (D800 DC00) before U+FFFF.
    expect(compareCodePoints('\u{10000}', '\uffff')).toBeGreaterThan(0);
    expect(compareCodePoints('\uffff', '\u{10000}')).toBeLessThan(0);
    expect(compareCodePoints('\u{1f600}', '\ue000')).toBeGreaterThan(0);
  });
});
