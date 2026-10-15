import type { PackageDependency } from './goModParser';

/**
 * Prints dependencies as a single go.mod `require` block.
 *
 * Output is `require (\n`, one `\t<path> <version>\n` line per dependency in
 * input order, then `)\n`. Values are written unquoted.
 */
export function printRequireBlock(deps: readonly PackageDependency[]): string {
  let out = 'require (\n';
  for (const dep of deps) {
    out += `\t${dep.path} ${dep.version}\n`;
  }
  return out + ')\n';
}
