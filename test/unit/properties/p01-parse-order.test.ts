import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { parseGoMod } from '../../../src/core/goModParser';
import { expectedDependencies, layoutArb, renderLayout, type Layout } from '../arbitraries';

// Feature: goget-manager-extension, Property 1: Parsing returns declared dependencies in file order
// **Validates: Requirements 4.1, 4.2, 4.9**

const EMPTY_LAYOUT: Layout = {
  chunks: [],
  after: [],
  format: { eol: '\n', bom: false, finalNewline: true },
};

describe('Property 1: Parsing returns declared dependencies in file order', () => {
  it('returns exactly the layout dependencies flattened in file order', () => {
    fc.assert(
      fc.property(layoutArb, (layout) => {
        const rendered = renderLayout(layout);
        const result = parseGoMod(rendered.text);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.dependencies).toEqual(expectedDependencies(layout));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('returns an empty dependency list for the empty layout', () => {
    const rendered = renderLayout(EMPTY_LAYOUT);
    const result = parseGoMod(rendered.text);
    expect(result).toEqual({ ok: true, dependencies: [] });
  });

  it('keeps single-line and block entries interleaved in file order', () => {
    const text = [
      'require a/one v1.0.0',
      'require (',
      '\tb/two v2.0.0',
      '\tc/three v3.0.0',
      ')',
      'require d/four v4.0.0',
      '',
    ].join('\n');
    const result = parseGoMod(text);
    expect(result).toEqual({
      ok: true,
      dependencies: [
        { path: 'a/one', version: 'v1.0.0' },
        { path: 'b/two', version: 'v2.0.0' },
        { path: 'c/three', version: 'v3.0.0' },
        { path: 'd/four', version: 'v4.0.0' },
      ],
    });
  });
});
