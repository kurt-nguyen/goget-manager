/**
 * Compares two strings by Unicode code point, returning <0, 0, or >0.
 *
 * JavaScript's default string comparison orders by UTF-16 code unit, which
 * misorders characters outside the BMP. This walks both strings one code point
 * at a time (1 or 2 code units each). A proper prefix sorts first.
 */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const ca = a.codePointAt(i)!;
    const cb = b.codePointAt(j)!;
    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }
    i += ca > 0xffff ? 2 : 1;
    j += cb > 0xffff ? 2 : 1;
  }
  if (i < a.length) {
    return 1;
  }
  if (j < b.length) {
    return -1;
  }
  return 0;
}
