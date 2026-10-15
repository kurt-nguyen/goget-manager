import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

/**
 * Pure HTML builder for the Search webview. Intentionally free of any
 * `vscode` usage so it can be unit tested directly.
 */
export function buildSearchHtml(
  cspSource: string,
  nonce: string,
  cssUri: string,
  jsUri: string,
): string {
  const csp = `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
  <title>Search Go packages</title>
</head>
<body>
  <input id="search" type="text" maxlength="256" placeholder="Search Go packages" aria-label="Search Go packages" spellcheck="false" autocomplete="off">
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

/** Generates a random nonce suitable for a CSP `script-src` directive. */
function generateNonce(): string {
  return randomBytes(16).toString('base64');
}

export class SearchViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'gogetManager.search';

  private resolved = false;

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** True once VS Code has asked this provider to resolve the view (read by the test API). */
  get isResolved(): boolean {
    return this.resolved;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.resolved = true;
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [mediaRoot],
    };

    const cssUri = view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'search.css'));
    const jsUri = view.webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'search.js'));

    view.webview.html = buildSearchHtml(
      view.webview.cspSource,
      generateNonce(),
      cssUri.toString(),
      jsUri.toString(),
    );
  }
}
