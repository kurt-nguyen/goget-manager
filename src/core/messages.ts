import type { SearchFailure } from './searchController';

export const NO_FOLDER = 'Open a folder containing a go.mod file to see installed packages.';

export const NO_GO_MOD = 'No go.mod file found in the current workspace.';

export const NO_PACKAGES = 'No packages installed.';

/** Message for a go.mod parse error. The line segment is omitted when no line is reported. */
export function parseError(path: string, line: number | undefined, msg: string): string {
  const linePart = line === undefined ? '' : `line ${line}: `;
  return `Failed to parse ${path}: ${linePart}${msg}`;
}

/** Message for a go.mod file that could not be read from disk. */
export function readError(path: string, reason: string): string {
  return `Could not read ${path}: ${reason}`;
}

/** Status_Message shown while a search is in flight. */
export const SEARCHING = 'Searching\u2026';

/** Status_Message for a successful search with at least one result. */
export function resultCount(n: number): string {
  return n === 1 ? '1 result' : `${n} results`;
}

/** Status_Message for a successful search with zero results. */
export function noResults(query: string): string {
  return `No packages found for "${query}".`;
}

export const UNREACHABLE = 'Could not reach pkg.go.dev. Check your internet connection and try again.';

export function httpError(status: number): string {
  return `pkg.go.dev returned an error (HTTP ${status}). Try again later.`;
}

export const TIMED_OUT = 'The search timed out. Try again.';

export function openFailedNotification(path: string): string {
  return `Could not open the pkg.go.dev page for ${path}.`;
}

/** Replaces line terminators so interpolated text cannot split a log line. */
function singleLine(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]+/g, ' ');
}

/** Output_Channel line for a failed search. `ts` is an ISO 8601 string. */
export function searchFailureLog(ts: string, query: string, failure: SearchFailure): string {
  const prefix = `[${ts}] Search for ${JSON.stringify(query)} failed: `;
  switch (failure.kind) {
    case 'unreachable':
      return `${prefix}unreachable (${singleLine(failure.reason)})`;
    case 'http':
      return `${prefix}HTTP error ${failure.status}`;
    case 'redirectBlocked':
      return `${prefix}HTTP error ${failure.status}, redirect to host ${singleLine(failure.targetHost)} blocked`;
    case 'timeout':
      return `${prefix}timeout after 10 s`;
  }
}

/** Output_Channel line for a package page that was refused before opening. */
export function openRefusedLog(ts: string, path: string, reason: 'emptyPath' | 'notPkgGoDev'): string {
  const text = reason === 'emptyPath' ? 'empty package path' : 'not an HTTPS pkg.go.dev URL';
  return `[${ts}] Did not open package page for ${JSON.stringify(path)}: ${text}`;
}

/** Output_Channel line for a package page that failed to open. */
export function openFailedLog(ts: string, path: string, reason: string): string {
  return `[${ts}] Could not open package page for ${JSON.stringify(path)}: ${singleLine(reason)}`;
}
