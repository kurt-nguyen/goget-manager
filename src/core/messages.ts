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

export const DETAIL_TIMED_OUT = 'Loading the package page timed out. Try again.';

export const DETAIL_BAD_PAGE = 'pkg.go.dev returned a page this extension could not read.';

export const DETAIL_NOT_FOUND = 'This package was not found on pkg.go.dev.';

export const DETAIL_INVALID_PATH = 'This package path is not valid.';

/** Status text shown while a package page is loading. */
export function detailLoading(path: string): string {
  return `Loading ${path}\u2026`;
}

/** Output_Channel line for a package page that failed to load. `ts` is an ISO 8601 string. */
export function detailFailureLog(
  ts: string,
  path: string,
  goos: string | undefined,
  failure: SearchFailure | { readonly kind: 'badPage' },
): string {
  const target = goos === undefined ? JSON.stringify(path) : `${JSON.stringify(path)} (GOOS=${singleLine(goos)})`;
  const prefix = `[${ts}] Loading package page ${target} failed: `;
  switch (failure.kind) {
    case 'unreachable':
      return `${prefix}unreachable (${singleLine(failure.reason)})`;
    case 'http':
      return `${prefix}HTTP error ${failure.status}`;
    case 'redirectBlocked':
      return `${prefix}HTTP error ${failure.status}, redirect to host ${singleLine(failure.targetHost)} blocked`;
    case 'timeout':
      return `${prefix}timeout`;
    case 'badPage':
      return `${prefix}unrecognised page`;
  }
}

/** Button labels while an Install/Uninstall is running. */
export const INSTALLING = 'Installing\u2026';
export const UNINSTALLING = 'Uninstalling\u2026';

export const NOT_INSTALLABLE = 'Standard library packages are part of Go and cannot be installed.';

export const NO_GO_MOD_FOR_INSTALL = 'No go.mod file found in the workspace. Open a folder that contains one.';

export const GO_NOT_FOUND = 'Go was not found. Install Go or add it to your PATH.';

export type PackageAction = 'install' | 'uninstall';

export function notRequired(path: string): string {
  return `${path} is not required by any go.mod in the workspace.`;
}

export function goTimedOut(action: PackageAction): string {
  return `The ${action} timed out. See the Goget Manager output for details.`;
}

export function goFailed(action: PackageAction, detail: string): string {
  return `The ${action} failed: ${singleLine(detail)}`;
}

export function installNotRecorded(path: string): string {
  return `go get finished but go.mod does not list ${path}.`;
}

export function uninstallNotRemoved(path: string): string {
  return `The uninstall finished but ${path} is still required by a go.mod in the workspace.`;
}

export const PICK_FOLDER_INSTALL = 'Choose the go.mod to install into';

export function pickFolderUninstall(path: string): string {
  return `Choose the go.mod to remove ${path} from`;
}

/** Output_Channel line for the start of an Install/Uninstall. `ts` is an ISO 8601 string. */
export function actionStartLog(ts: string, action: PackageAction, path: string, cwd: string, args: readonly string[]): string {
  const label = action === 'install' ? 'Install' : 'Uninstall';
  return `[${ts}] ${label} ${singleLine(path)}: running "go ${singleLine(args.join(' '))}" in ${singleLine(cwd)}`;
}

/** Output_Channel text for the outcome of an Install/Uninstall; Go's raw output follows, indented. */
export function actionResultLog(ts: string, action: PackageAction, path: string, outcome: string, output: string): string {
  const label = action === 'install' ? 'Install' : 'Uninstall';
  const header = `[${ts}] ${label} ${singleLine(path)}: ${singleLine(outcome)}`;
  const body = output
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '')
    .map((line) => `    ${line}`);
  return [header, ...body].join('\n');
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
