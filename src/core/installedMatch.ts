/**
 * Pure installed-package matching for the Search view. No `vscode` import.
 *
 * Decides whether a search result is already listed in the Installed view,
 * ignoring versions. Reuses the installed snapshot; go.mod is not parsed here.
 */

import { compareCodePoints } from './compare';
import type { InstalledSnapshot } from './installedModel';

/** Module paths of every parsed go.mod, deduplicated, sorted by code point. */
export function collectInstalledModulePaths(snapshot: InstalledSnapshot): string[] {
  const paths = new Set<string>();
  for (const folder of snapshot.folders) {
    if (folder.kind === 'parsed') {
      for (const dep of folder.dependencies) {
        paths.add(dep.path);
      }
    }
  }
  return [...paths].sort(compareCodePoints);
}

const MAJOR_VERSION_SEGMENT = /^v(?:[2-9]|[1-9]\d+)$/;

/**
 * True when `packagePath` is an installed module or a package inside one.
 * Versions are ignored. `M/vN` is a different module than `M`.
 */
export function isInstalledPackage(packagePath: string, installed: ReadonlySet<string>): boolean {
  if (installed.has(packagePath)) {
    return true;
  }
  for (let end = packagePath.lastIndexOf('/'); end > 0; end = packagePath.lastIndexOf('/', end - 1)) {
    if (!installed.has(packagePath.slice(0, end))) {
      continue;
    }
    const next = packagePath.slice(end + 1).split('/', 1)[0] ?? '';
    if (!MAJOR_VERSION_SEGMENT.test(next)) {
      return true;
    }
  }
  return false;
}
