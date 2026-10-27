import type { PackageResult } from './resultsParser';
import { clampSearchText } from './searchText';

/** Maximum number of code points of a synopsis shown in the Result_List. */
export const MAX_SYNOPSIS = 300;

/** A result as displayed in the webview. */
export interface ResultEntry {
  readonly path: string;
  readonly name: string;
  /** Truncated: the first 300 code points plus "…" when longer. */
  readonly synopsis?: string;
  readonly version?: string;
  readonly published?: string;
  readonly importedBy?: string;
}

/**
 * Returns `text` unchanged when it has `max` or fewer code points, otherwise
 * its first `max` code points followed by "…" (U+2026). Never splits a
 * surrogate pair.
 */
export function truncateSynopsis(text: string, max: number = MAX_SYNOPSIS): string {
  const clamped = clampSearchText(text, max);
  return clamped.length === text.length ? text : `${clamped}\u2026`;
}

/** Copies the fields of `result`, truncating the synopsis. Absent fields stay absent. */
export function toResultEntry(result: PackageResult): ResultEntry {
  return {
    path: result.path,
    name: result.name,
    ...(result.synopsis !== undefined && { synopsis: truncateSynopsis(result.synopsis) }),
    ...(result.version !== undefined && { version: result.version }),
    ...(result.published !== undefined && { published: result.published }),
    ...(result.importedBy !== undefined && { importedBy: result.importedBy }),
  };
}
