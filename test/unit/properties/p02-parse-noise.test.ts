import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { parseGoMod } from '../../../src/core/goModParser';
import { cleanLayout, noisyLayoutArb, renderLayout } from '../arbitraries';

// Feature: goget-manager-extension, Property 2: Presentation noise does not change parse output
// **Validates: Requirements 4.3, 4.4, 4.5**

describe('Property 2: Presentation noise does not change parse output', () => {
  it('parses a noisy rendering to the same dependencies as the clean rendering', () => {
    fc.assert(
      fc.property(noisyLayoutArb, (layout) => {
        const clean = parseGoMod(renderLayout(cleanLayout(layout)).text);
        const noisy = parseGoMod(renderLayout(layout).text);

        expect(clean.ok).toBe(true);
        expect(noisy.ok).toBe(true);
        if (clean.ok && noisy.ok) {
          expect(noisy.dependencies).toEqual(clean.dependencies);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('returns exactly the layout dependencies for the noisy rendering', () => {
    fc.assert(
      fc.property(noisyLayoutArb, (layout) => {
        const rendered = renderLayout(layout);
        const result = parseGoMod(rendered.text);

        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.dependencies).toEqual(rendered.dependencies);
        }
      }),
      { numRuns: 200 },
    );
  });
});
