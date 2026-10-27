import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { DetailController } from '../core/detailController';
import { buildDetailHtml } from '../core/detailHtml';
import { parseDetailMessage, type DetailViewModel, type HostToDetail } from '../core/detailProtocol';
import type { DetailOpener } from './searchViewProvider';

/** The slice of `vscode.WebviewPanel` the manager uses. */
export interface PanelLike {
  readonly webview: {
    options: vscode.WebviewOptions;
    html: string;
    readonly cspSource: string;
    asWebviewUri(uri: vscode.Uri): vscode.Uri;
    postMessage(message: unknown): PromiseLike<boolean>;
    onDidReceiveMessage(listener: (message: unknown) => unknown): vscode.Disposable;
  };
  title: string;
  iconPath?: vscode.WebviewPanel['iconPath'];
  reveal(column?: vscode.ViewColumn, preserveFocus?: boolean): void;
  onDidDispose(listener: () => unknown): vscode.Disposable;
  dispose(): void;
}

export type PanelFactory = (mediaRoot: vscode.Uri) => PanelLike;

const VIEW_TYPE = 'gogetManager.detail';
const PANEL_TITLE = 'GoGet';

function packageName(path: string): string {
  const segments = path.split('/').filter((segment) => segment !== '');
  const last = segments[segments.length - 1] ?? path;
  const previous = segments[segments.length - 2];
  return /^v\d+$/.test(last) && previous !== undefined ? previous : last;
}

function panelTitle(state: DetailViewModel): string {
  const name = state.detail?.importPath === state.path ? state.detail.title : packageName(state.path);
  return `GoGet: ${name}`;
}

const defaultCreatePanel: PanelFactory = (mediaRoot) =>
  vscode.window.createWebviewPanel(VIEW_TYPE, PANEL_TITLE, vscode.ViewColumn.Active, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [mediaRoot],
  });

/**
 * Owns the single package detail tab. Selecting another package re-uses the
 * open tab; closing the tab resets the controller so the next selection opens
 * a fresh one.
 */
export class DetailPanelManager implements vscode.Disposable, DetailOpener {
  private panel: PanelLike | undefined;
  private subscriptions: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: DetailController,
    private readonly openExternal: (url: string) => PromiseLike<boolean>,
    private readonly createPanel: PanelFactory = defaultCreatePanel,
  ) {}

  get isOpen(): boolean {
    return this.panel !== undefined;
  }

  show(path: string): void {
    if (this.panel !== undefined) {
      this.panel.reveal(undefined, true);
    } else {
      this.open();
    }
    this.controller.show(path);
  }

  dispose(): void {
    const panel = this.panel;
    this.disposeSubscriptions();
    this.panel = undefined;
    panel?.dispose();
  }

  private open(): void {
    const mediaRoot = vscode.Uri.joinPath(this.extensionUri, 'media');
    const panel = this.createPanel(mediaRoot);
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'imgs', 'goget-manager-icon.png');

    const webview = panel.webview;
    const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'detail.css'));
    const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(mediaRoot, 'detail.js'));
    webview.html = buildDetailHtml(
      webview.cspSource,
      randomBytes(16).toString('base64'),
      cssUri.toString(),
      jsUri.toString(),
    );

    const post = (message: HostToDetail): void => {
      void Promise.resolve(webview.postMessage(message)).catch(() => undefined);
    };

    this.subscriptions.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        const message = parseDetailMessage(raw);
        if (message === undefined) {
          return;
        }
        switch (message.type) {
          case 'ready':
            post(this.controller.snapshot());
            break;
          case 'changeGoos':
            this.controller.changeGoos(message.goos);
            break;
          case 'retry':
            this.controller.retry();
            break;
          case 'install':
            this.controller.requestInstall();
            break;
          case 'uninstall':
            this.controller.requestUninstall();
            break;
          case 'openLink':
            try {
              void Promise.resolve(this.openExternal(message.url)).catch(() => undefined);
            } catch {
              // Opening a link is best effort.
            }
            break;
        }
      }),
      this.controller.onDidChange((message) => {
        post(message);
        if (message.type === 'state' && message.state.path !== '') {
          panel.title = panelTitle(message.state);
        }
      }),
      panel.onDidDispose(() => {
        this.disposeSubscriptions();
        this.panel = undefined;
        this.controller.reset();
      }),
    );
  }

  private disposeSubscriptions(): void {
    const subscriptions = this.subscriptions;
    this.subscriptions = [];
    for (const subscription of subscriptions) {
      subscription.dispose();
    }
  }
}
