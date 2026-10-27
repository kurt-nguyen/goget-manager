import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePackageDetail, type Link, type PackageDetail } from '../../src/core/packageDetail';

function fixture(name: string): string {
  return readFileSync(join(__dirname, '..', 'fixtures', 'package-detail', name), 'utf8');
}

const sftpHtml = fixture('sftp-sample.html');
const liveHtml = fixture('live-style.html');

function allLinks(detail: PackageDetail): Link[] {
  return [
    ...(detail.version ? [detail.version] : []),
    ...detail.licenses,
    ...(detail.imports ? [detail.imports] : []),
    ...(detail.importedBy ? [detail.importedBy] : []),
    ...(detail.repository ? [detail.repository] : []),
    ...detail.links,
  ];
}

describe('parsePackageDetail on the saved sftp page', () => {
  const detail = parsePackageDetail(sftpHtml, 'github.com/pkg/sftp/v2') as PackageDetail;

  it('extracts the header fields', () => {
    expect(detail).toBeDefined();
    expect(detail.path).toBe('github.com/pkg/sftp/v2');
    expect(detail.pageUrl).toBe('https://pkg.go.dev/github.com/pkg/sftp/v2');
    expect(detail.title).toBe('sftp');
    expect(detail.chips).toEqual(['package', 'module']);
    expect(detail.importPath).toBe('github.com/pkg/sftp/v2');
    expect(detail.version).toEqual({
      text: 'v2.0.0-alpha2',
      url: 'https://pkg.go.dev/github.com/pkg/sftp/v2?tab=versions',
    });
    expect(detail.published).toBe('May 4, 2026');
    expect(detail.licenses).toEqual([
      { text: 'BSD-2-Clause', url: 'https://pkg.go.dev/github.com/pkg/sftp/v2?tab=licenses' },
    ]);
    expect(detail.imports).toEqual({ text: '20', url: 'https://pkg.go.dev/github.com/pkg/sftp/v2?tab=imports' });
    expect(detail.importedBy).toEqual({ text: '1', url: 'https://pkg.go.dev/github.com/pkg/sftp/v2?tab=importedby' });
  });

  it('extracts the details checks, repository and links', () => {
    expect(detail.checks).toEqual([
      { label: 'Valid go.mod file', ok: true },
      { label: 'Redistributable license', ok: true },
      { label: 'Tagged version', ok: true },
      { label: 'Stable version', ok: false },
    ]);
    expect(detail.repository).toEqual({ text: 'github.com/pkg/sftp', url: 'https://github.com/pkg/sftp' });
    expect(detail.links.map((l) => l.text)).toContain('Open Source Insights');
    expect(detail.links[0]?.url).toBe('https://deps.dev/go/github.com%2Fpkg%2Fsftp%2Fv2/v2.0.0-alpha2');
  });

  it('extracts the sanitized README', () => {
    const readme = detail.readmeHtml as string;
    expect(readme).toContain('<h3 class="h2" id="pd-readme-sftp">sftp</h3>');
    expect(readme).toContain('usage and examples');
    expect(readme).not.toContain('<script');
    expect(readme).not.toMatch(/\son\w+=/u);
  });

  it('extracts the sanitized documentation with rewritten links', () => {
    const doc = detail.docHtml as string;
    expect(doc).toContain('Documentation-index');
    expect(doc).toContain('id="pd-FormatLongname"');
    expect(doc).toContain('href="#pd-pkg-constants"');
    expect(doc).toContain('href="https://pkg.go.dev/os#O_RDONLY"');
    expect(doc).not.toContain('GOOS');
    expect(doc).not.toContain('<script');
  });

  it('extracts the build context with the selected GOOS', () => {
    expect(detail.buildContext).toEqual({
      selected: 'windows',
      options: [
        { value: 'linux', label: 'linux/amd64' },
        { value: 'windows', label: 'windows/amd64' },
        { value: 'darwin', label: 'darwin/amd64' },
        { value: 'js', label: 'js/wasm' },
      ],
    });
  });

  it('only reports absolute http(s) URLs', () => {
    for (const link of allLinks(detail)) {
      expect(link.url).toMatch(/^https?:\/\//u);
    }
  });
});

describe('parsePackageDetail on the live-style page', () => {
  const detail = parsePackageDetail(liveHtml, 'github.com/spf13/cobra') as PackageDetail;

  it('resolves root-relative and query-relative header links to absolute pkg.go.dev URLs', () => {
    expect(detail.importPath).toBe('github.com/spf13/cobra');
    expect(detail.title).toBe('cobra');
    expect(detail.chips).toEqual(['package']);
    expect(detail.version).toEqual({ text: 'v1.10.2', url: 'https://pkg.go.dev/github.com/spf13/cobra?tab=versions' });
    expect(detail.published).toBe('Dec 4, 2025');
    expect(detail.licenses).toEqual([
      { text: 'Apache-2.0', url: 'https://pkg.go.dev/github.com/spf13/cobra?tab=licenses' },
      { text: 'MIT', url: 'https://pkg.go.dev/github.com/spf13/cobra?tab=licenses#lic-1' },
    ]);
    expect(detail.imports).toEqual({ text: '8', url: 'https://pkg.go.dev/github.com/spf13/cobra?tab=imports' });
    expect(detail.importedBy).toEqual({
      text: '195,884',
      url: 'https://pkg.go.dev/github.com/spf13/cobra?tab=importedby',
    });
    for (const link of allLinks(detail)) {
      expect(link.url).toMatch(/^https:\/\//u);
    }
  });

  it('extracts checks, repository and links in the live shape', () => {
    expect(detail.checks).toEqual([
      { label: 'Valid go.mod file', ok: true },
      { label: 'Stable version', ok: false },
    ]);
    expect(detail.repository).toEqual({ text: 'github.com/spf13/cobra', url: 'https://github.com/spf13/cobra' });
    expect(detail.links).toEqual([
      { text: 'Open Source Insights', url: 'https://deps.dev/go/github.com%2Fspf13%2Fcobra/v1.10.2' },
    ]);
  });

  it('selects the first option when no option has the selected attribute', () => {
    expect(detail.buildContext?.selected).toBe('linux');
    expect(detail.buildContext?.options.map((o) => o.value)).toEqual(['linux', 'windows', 'darwin', 'js']);
  });

  it('omits the README when the page has none', () => {
    expect(detail.readmeHtml).toBeUndefined();
    expect('readmeHtml' in detail).toBe(false);
  });

  it('rewrites documentation links and images', () => {
    const doc = detail.docHtml as string;
    expect(doc).toContain('href="https://pkg.go.dev/syscall#O_RDONLY"');
    expect(doc).toContain('href="https://pkg.go.dev/os"');
    expect(doc).toContain('href="#pd-pkg-overview"');
    expect(doc).toContain('href="https://pkg.go.dev/github.com/spf13/cobra?tab=versions"');
    expect(doc).toContain('href="https://pkg.go.dev/github.com/spf13/cobra?tab=imports"');
    expect(doc).toContain('href="https://pkg.go.dev/os#pkg-index"');
    expect(doc).toContain('src="https://pkg.go.dev/static/shared/icon/help_gm_grey_24dp.svg"');
    expect(doc).toContain('id="pd-Flags"');
  });

  it('omits buildContext when there is no select', () => {
    const withoutSelect = liveHtml.replace(/<select[\s\S]*?<\/select>/u, '');
    const result = parsePackageDetail(withoutSelect, 'github.com/spf13/cobra') as PackageDetail;
    expect(result).toBeDefined();
    expect(result.buildContext).toBeUndefined();
    expect('buildContext' in result).toBe(false);
  });

  it('omits buildContext when the select has no options', () => {
    const empty = liveHtml.replace(/<option[\s\S]*?<\/option>/gu, '');
    const result = parsePackageDetail(empty, 'github.com/spf13/cobra') as PackageDetail;
    expect('buildContext' in result).toBe(false);
  });
});

describe('parsePackageDetail edge cases', () => {
  it('honours a bare selected attribute', () => {
    const html =
      '<article class="go-Main-article"><select class="go-Select js-buildContextSelect">' +
      '<option value="linux">linux/amd64</option><option selected value="windows">windows/amd64</option></select></article>';
    const detail = parsePackageDetail(html, 'example.com/mod/pkg') as PackageDetail;
    expect(detail.buildContext?.selected).toBe('windows');
    expect(detail.title).toBe('pkg');
    expect(detail.importPath).toBe('example.com/mod/pkg');
    expect(detail.chips).toEqual([]);
    expect(detail.checks).toEqual([]);
    expect(detail.licenses).toEqual([]);
    expect(detail.links).toEqual([]);
  });

  it('falls back to the clipboard button for the import path', () => {
    const html =
      '<header class="go-Main-header"><h1 data-test-id="UnitHeader-title">x</h1>' +
      '<button class="js-clipboard" data-to-copy="example.com/clip"></button></header>';
    expect((parsePackageDetail(html, 'example.com/req') as PackageDetail).importPath).toBe('example.com/clip');
  });

  it('reads counts from the anchor text when aria-label is missing', () => {
    const html =
      '<header class="go-Main-header"><h1 data-test-id="UnitHeader-title">x</h1>' +
      '<span data-test-id="UnitHeader-imports"><a href="?tab=imports"><span class="go-textSubtle">Imports: </span>12</a></span>' +
      '<span data-test-id="UnitHeader-version"><a href="?tab=versions"><span class="go-textSubtle">Version: </span> v1.2.3</a></span></header>';
    const detail = parsePackageDetail(html, 'example.com/p') as PackageDetail;
    expect(detail.imports).toEqual({ text: '12', url: 'https://pkg.go.dev/example.com/p?tab=imports' });
    expect(detail.version).toEqual({ text: 'v1.2.3', url: 'https://pkg.go.dev/example.com/p?tab=versions' });
  });

  it('returns undefined for unrecognised pages', () => {
    expect(parsePackageDetail('<html></html>', 'os')).toBeUndefined();
    expect(parsePackageDetail('', 'os')).toBeUndefined();
    expect(parsePackageDetail('<h1>not a package</h1><p>hi</p>', 'os')).toBeUndefined();
    expect(parsePackageDetail(undefined as unknown as string, 'os')).toBeUndefined();
    expect(parsePackageDetail('<html></html>', undefined as unknown as string)).toBeUndefined();
  });

  it('does not throw on truncated pages', () => {
    for (const html of [sftpHtml, liveHtml]) {
      for (const fraction of [0.05, 0.2, 0.33, 0.5, 0.75, 0.9, 0.999]) {
        const cut = html.slice(0, Math.floor(html.length * fraction));
        expect(() => parsePackageDetail(cut, 'github.com/pkg/sftp/v2')).not.toThrow();
      }
    }
  });
});
