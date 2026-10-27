import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { SearchController } from '../core/searchController';
import { parseWebviewMessage, type HostToWebview, type SearchViewModel } from '../core/searchProtocol';

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
  const csp = `default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; img-src data:`;
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
  <div id="loading" class="loading" hidden aria-hidden="true"><div class="loading-bar"></div></div>
  <div id="status" class="status" role="status" aria-live="polite"></div>
  <ul id="results" class="results" aria-label="Search results"></ul>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

/** Generates a random nonce suitable for a CSP `script-src` directive. */
function generateNonce(): string {
  return randomBytes(16).toString('base64');
}

/** Only the SearchViewModel keys are sent to the webview. */
function toPostedState(state: SearchViewModel): SearchViewModel {
  return {
    results: state.results,
    status: state.status,
    loading: state.loading,
    resultsVersion: state.resultsVersion,
  };
}

/** The slice of the go.mod repository the Search view needs to show Installed badges. */
export interface InstalledModulesSource {
  readonly onDidChange: vscode.Event<void>;
  modules(): readonly string[];
}

export class SearchViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'gogetManager.search';

  private resolved = false;
  private viewSubscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: SearchController,
    private readonly installed?: InstalledModulesSource,
  ) {}

  /** True once VS Code has asked this provider to resolve the view (read by the test API). */
  get isResolved(): boolean {
    return this.resolved;
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.resolved = true;
    this.disposeViewSubscriptions();
    const webview = view.webview;
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

    const post = (state: SearchViewModel): void => {
      const message: HostToWebview = { type: 'state', state: toPostedState(state) };
      void Promise.resolve(webview.postMessage(message)).catch(() => undefined);
    };

    const installed = this.installed;
    const postInstalled = (): void => {
      if (installed === undefined) {
        return;
      }
      const message: HostToWebview = { type: 'installed', modules: installed.modules() };
      void Promise.resolve(webview.postMessage(message)).catch(() => undefined);
    };

    this.viewSubscriptions.push(
      ...(installed ? [installed.onDidChange(postInstalled)] : []),
      webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseWebviewMessage(raw);
        if (message === undefined) {
          return;
        }
        switch (message.type) {
          case 'ready':
            postInstalled();
            post(this.controller.state);
            break;
          case 'query':
            this.controller.queryChanged(message.text);
            break;
          case 'submit':
            this.controller.submit(message.text);
            break;
          case 'open':
            void this.controller.open(message.resultsVersion, message.index);
            break;
        }
      }),
      this.controller.onDidChangeState(post),
      view.onDidDispose(() => {
        this.disposeViewSubscriptions();
      }),
    );
  }

  dispose(): void {
    this.disposeViewSubscriptions();
  }

  private disposeViewSubscriptions(): void {
    const subscriptions = this.viewSubscriptions;
    this.viewSubscriptions = [];
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  }
}
