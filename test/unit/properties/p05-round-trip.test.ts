import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { parseGoMod } from '../../../src/core/goModParser';
import { printRequireBlock } from '../../../src/core/requirePrinter';
import { validDependencyArb } from '../arbitraries';

// Feature: goget-manager-extension, Property 5: Print then parse round trip
describe('Property 5: Print then parse round trip', () => {
  /**
   * **Validates: Requirements 4.8**
   */
  it('parseGoMod(printRequireBlock(deps)) returns deps unchanged, in order', () => {
    fc.assert(
      fc.property(fc.array(validDependencyArb, { maxLength: 20 }), (deps) => {
        const result = parseGoMod(printRequireBlock(deps));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.dependencies).toHaveLength(deps.length);
        deps.forEach((dep, i) => {
          expect(result.dependencies[i]!.path).toBe(dep.path);
          expect(result.dependencies[i]!.version).toBe(dep.version);
        });
      }),
      { numRuns: 200 },
    );
  });

  it('round-trips the empty list', () => {
    const result = parseGoMod(printRequireBlock([]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dependencies).toHaveLength(0);
  });
});
