import { describe, expect, it } from 'vitest';
import { buildDetailHtml } from '../../src/core/detailHtml';

describe('buildDetailHtml', () => {
  const nonce = 'abc123NONCE==';
  const html = buildDetailHtml('vscode-webview-resource:', nonce, 'vscode-resource:/media/detail.css', 'vscode-resource:/media/detail.js');

  it('has the strict CSP with the nonce', () => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1]!;
    expect(csp).toBe(
      `default-src 'none'; style-src vscode-webview-resource:; script-src 'nonce-${nonce}'; img-src https: data: vscode-webview-resource:; font-src vscode-webview-resource:`,
    );
    expect(csp).not.toContain("'unsafe-inline'");
    expect(csp).not.toContain('connect-src');
  });

  it('has exactly one script tag, carrying the nonce and the script uri', () => {
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toEqual([`<script nonce="${nonce}" src="vscode-resource:/media/detail.js">`]);
  });

  it('links the stylesheet and has no inline style or event handlers', () => {
    expect(html).toContain('<link rel="stylesheet" href="vscode-resource:/media/detail.css">');
    expect(html).not.toMatch(/<style\b/);
    expect(html).not.toMatch(/\sstyle=/);
    expect(html).not.toMatch(/\son[a-z]+=/i);
  });

  it('has the status, error, header and main containers', () => {
    const status = /<[a-z]+\b[^>]*\bid="detail-status"[^>]*>/.exec(html)?.[0];
    expect(status).toContain('role="status"');
    expect(status).toContain('aria-live="polite"');
    const error = /<[a-z]+\b[^>]*\bid="detail-error"[^>]*>/.exec(html)?.[0];
    expect(error).toContain('role="alert"');
    expect(error).toMatch(/\bhidden\b/);
    expect(html).toMatch(/<header\b[^>]*\bid="detail-header"/);
    const actionError = /<[a-z]+\b[^>]*\bid="detail-action-error"[^>]*>/.exec(html)?.[0];
    expect(actionError).toContain('role="alert"');
    expect(actionError).toMatch(/\bhidden\b/);
    expect(html).toMatch(/<main\b[^>]*\bid="detail-main"/);
    expect(html).toMatch(/<div\b[^>]*\bid="detail-root"/);
    expect(html).toContain('<title>Package details</title>');
  });
});
