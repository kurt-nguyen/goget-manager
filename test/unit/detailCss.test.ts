import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(__dirname, '..', '..', 'media', 'detail.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('media/detail.css', () => {
  it('uses theme variables for colours and never a fixed colour', () => {
    expect(css).toContain('var(--vscode-foreground)');
    expect(css).toContain('var(--vscode-editor-background)');
    expect(css).toContain('var(--vscode-focusBorder)');
    expect(css).toContain('var(--vscode-textLink-foreground)');
    expect(css).toContain('var(--vscode-progressBar-background)');
    expect(css).toContain('var(--vscode-errorForeground)');
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/i);
    expect(css).not.toMatch(/:\s*(?:[^;{}]*\s)?(white|black|red|green|blue|gray|grey|transparent|yellow|orange)\b/i);
  });

  it('honours reduced motion and has no inline-style dependent rules', () => {
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('[hidden]');
  });
});
