import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { printRequireBlock } from '../../../src/core/requirePrinter';
import { validDependencyArb } from '../arbitraries';

// Feature: goget-manager-extension, Property 4: Printer emits the required block structure
describe('Property 4: Printer emits the required block structure', () => {
  /**
   * **Validates: Requirements 4.7**
   */
  it('emits k + 2 lines: `require (`, one tab-indented entry per dependency in order, then `)`', () => {
    fc.assert(
      fc.property(fc.array(validDependencyArb, { maxLength: 20 }), (deps) => {
        const text = printRequireBlock(deps);

        // The block is newline-terminated; strip the final terminator before splitting into lines.
        expect(text.endsWith('\n')).toBe(true);
        const lines = text.slice(0, -1).split('\n');

        expect(lines).toHaveLength(deps.length + 2);
        expect(lines[0]).toBe('require (');
        expect(lines[lines.length - 1]).toBe(')');
        deps.forEach((dep, i) => {
          expect(lines[i + 1]).toBe(`\t${dep.path} ${dep.version}`);
        });
      }),
      { numRuns: 200 },
    );
  });

  it('prints the empty list as an empty block', () => {
    expect(printRequireBlock([])).toBe('require (\n)\n');
  });
});
