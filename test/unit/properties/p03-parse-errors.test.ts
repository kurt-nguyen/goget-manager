import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { parseGoMod } from '../../../src/core/goModParser';
import {
  UNCLOSED_REQUIRE_LINE,
  joinLines,
  layoutArb,
  missingTokenBlockLineArb,
  missingTokenTopLevelLineArb,
  noisyLayoutArb,
  renderLayout,
} from '../arbitraries';
import type { Layout, RenderedLayout } from '../arbitraries';

// Feature: goget-manager-extension, Property 3: Malformed input reports the defect's line and no dependencies
// **Validates: Requirements 4.6, 4.10**

type DefectKind = 'topInsert' | 'topReplace' | 'blockInsert' | 'blockReplace' | 'unclosed';

interface Injection {
  readonly lines: string[];
  /** 1-based line of the injected defect. */
  readonly line: number;
}

const defectKindArb = fc.constantFrom<DefectKind>(
  'topInsert',
  'topReplace',
  'blockInsert',
  'blockReplace',
  'unclosed',
);

/**
 * Injects exactly one defect into a rendered, valid go.mod and records its line.
 * Falls back to an unclosed `require (` when the layout has no site for the chosen kind.
 */
function inject(
  r: RenderedLayout,
  kind: DefectKind,
  pick: number,
  topLine: string,
  blockLine: string,
): Injection {
  const lines = [...r.lines];
  const blocks = r.chunks.filter((c) => c.kind === 'block' && c.openLine !== c.closeLine);

  // Candidate sites; each yields a function that edits `lines` and returns the defect line.
  const sites: Array<() => number> = [];

  if (kind === 'topInsert') {
    // Top-level boundaries: before line 1, after each chunk, and at the end.
    const boundaries = [0, ...r.chunks.map((c) => c.closeLine), r.lineCount];
    for (const b of boundaries) {
      sites.push(() => {
        lines.splice(b, 0, topLine);
        return b + 1;
      });
    }
  } else if (kind === 'topReplace') {
    for (const c of r.chunks) {
      if (c.kind === 'single') {
        sites.push(() => {
          lines[c.openLine - 1] = topLine;
          return c.openLine;
        });
      }
    }
  } else if (kind === 'blockInsert') {
    for (const c of blocks) {
      for (let n = c.openLine + 1; n <= c.closeLine; n++) {
        sites.push(() => {
          lines.splice(n - 1, 0, blockLine);
          return n;
        });
      }
    }
  } else if (kind === 'blockReplace') {
    for (const c of blocks) {
      for (const n of c.entryLines) {
        sites.push(() => {
          lines[n - 1] = blockLine;
          return n;
        });
      }
    }
  }

  if (sites.length === 0) {
    lines.push(UNCLOSED_REQUIRE_LINE);
    return { lines, line: r.lineCount + 1 };
  }
  const line = sites[pick % sites.length]!();
  return { lines, line };
}

describe('Property 3: Malformed input reports the defect\'s line and no dependencies', () => {
  const run = (layouts: fc.Arbitrary<Layout>) =>
    fc.assert(
      fc.property(
        layouts,
        defectKindArb,
        fc.nat(),
        missingTokenTopLevelLineArb,
        missingTokenBlockLineArb,
        (layout, kind, pick, topLine, blockLine) => {
          const rendered = renderLayout(layout);
          // Sanity: the untouched text is valid.
          expect(parseGoMod(rendered.text).ok).toBe(true);

          const injected = inject(rendered, kind, pick, topLine, blockLine);
          const result = parseGoMod(joinLines(injected.lines, layout.format));

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.line).toBe(injected.line);
            expect('dependencies' in result).toBe(false);
          }
        },
      ),
      { numRuns: 300 },
    );

  it('reports the defect line for a single defect in clean layouts', () => {
    run(layoutArb);
  });

  it('reports the defect line for a single defect in noisy layouts', () => {
    run(noisyLayoutArb);
  });

  it('reports the opening line of a require block that is never closed', () => {
    const result = parseGoMod('module m\n\nrequire (\n\ta v1.0.0\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.line).toBe(3);
    }
  });

  it('reports a require line with a missing version', () => {
    const result = parseGoMod('module m\nrequire a/b\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.line).toBe(2);
    }
  });
});
