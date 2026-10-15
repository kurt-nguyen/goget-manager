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
