/** Default maximum number of code points kept in the Search_Box. */
export const MAX_SEARCH_TEXT = 256;

/**
 * Returns the first `max` Unicode code points of `text`.
 *
 * Truncation happens on code point boundaries, so a surrogate pair is never
 * split. The result is always a prefix of `text`, and equals `text` when it
 * has `max` or fewer code points.
 */
export function clampSearchText(text: string, max: number = MAX_SEARCH_TEXT): string {
  if (!(max > 0)) {
    return '';
  }
  const limit = Math.floor(max);
  // Each code point uses at least one UTF-16 code unit, so a string with
  // `length <= limit` cannot have more than `limit` code points.
  if (text.length <= limit) {
    return text;
  }

  let count = 0;
  let end = 0;
  while (end < text.length) {
    if (count === limit) {
      return text.slice(0, end);
    }
    const cp = text.codePointAt(end) as number;
    end += cp > 0xffff ? 2 : 1;
    count++;
  }
  return text;
}
