import { describe, expect, it } from 'vitest';
import { packageDetailUrl } from '../../src/core/detailUrl';
import { parsePackageDetail } from '../../src/core/packageDetail';
import { nodeHttpsTransport, PkgGoDevSearchClient } from '../../src/vscode/searchClient';

/** Opt-in smoke test against the real pkg.go.dev. Run with `GOGET_LIVE=1`. */
describe.skipIf(process.env.GOGET_LIVE !== '1')('live pkg.go.dev package pages', () => {
  const client = new PkgGoDevSearchClient(nodeHttpsTransport);

  async function load(path: string): Promise<{ html: string; parsed: ReturnType<typeof parsePackageDetail>; ms: number }> {
    const target = packageDetailUrl(path);
    if (!target.ok) {
      throw new Error(`invalid path ${path}`);
    }
    const response = await client.search(target.url, AbortSignal.timeout(30_000));
    if (response.kind !== 'ok') {
      throw new Error(`fetch of ${path} failed: ${JSON.stringify(response)}`);
    }
    const started = performance.now();
    const parsed = parsePackageDetail(response.html, path);
    return { html: response.html, parsed, ms: performance.now() - started };
  }

  it.each([
    ['os', true],
    ['golang.org/x/sys/unix', true],
    ['github.com/spf13/cobra', true],
    ['github.com/pkg/errors', false],
  ])('parses %s', async (path, hasBuildContext) => {
    const { parsed } = await load(path);
    expect(parsed).toBeDefined();
    const detail = parsed as NonNullable<typeof parsed>;
    expect(detail.title).not.toBe('');
    expect(detail.version?.text).toBeTruthy();
    expect(detail.docHtml).toBeTruthy();
    if (hasBuildContext) {
      expect(detail.buildContext).toBeDefined();
      expect(detail.buildContext?.options.length).toBeGreaterThan(0);
    } else {
      expect(detail.buildContext).toBeUndefined();
    }
    for (const html of [detail.readmeHtml, detail.docHtml]) {
      if (html !== undefined) {
        expect(html).not.toContain('<script');
        expect(html).not.toContain(' onerror=');
      }
    }
    for (const link of [detail.version, detail.imports, detail.importedBy, detail.repository, ...detail.licenses]) {
      if (link !== undefined) {
        expect(link.url).toMatch(/^https?:\/\//u);
      }
    }
  }, 60_000);

  it('parses the 2.2 MB golang.org/x/sys/unix page in under 5 seconds', async () => {
    const { html, parsed, ms } = await load('golang.org/x/sys/unix');
    expect(html.length).toBeGreaterThan(1_000_000);
    expect(parsed).toBeDefined();
    expect(ms).toBeLessThan(5_000);
  }, 60_000);
});
