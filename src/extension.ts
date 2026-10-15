import * as vscode from 'vscode';
import { GoModRepository, createDefaultDeps } from './vscode/goModRepository';
import { InstalledTreeProvider } from './vscode/installedTreeProvider';
import { SearchViewProvider } from './vscode/searchViewProvider';
import { createTestApi } from './vscode/testApi';
import type { GogetManagerApi } from './vscode/testApi';

export function activate(context: vscode.ExtensionContext): GogetManagerApi {
  const output = vscode.window.createOutputChannel('Goget Manager');
  const repository = new GoModRepository(createDefaultDeps(output));

  const treeProvider = new InstalledTreeProvider(repository);
  const treeView = vscode.window.createTreeView('gogetManager.installed', {
    treeDataProvider: treeProvider,
    showCollapseAll: false,
  });

  const searchProvider = new SearchViewProvider(context.extensionUri);
  const searchRegistration = vscode.window.registerWebviewViewProvider(SearchViewProvider.viewId, searchProvider, {
    webviewOptions: { retainContextWhenHidden: true },
  });

  const refreshCommand = vscode.commands.registerCommand('gogetManager.refresh', () => repository.refreshAll());

  context.subscriptions.push(output, repository, treeProvider, treeView, searchRegistration, refreshCommand);

  void repository.initialize().catch((err: unknown) => {
    output.appendLine(
      `[${new Date().toISOString()}] Failed to initialize: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  });

  return createTestApi({ treeProvider, treeView, searchProvider });
}

export function deactivate(): void {
  // Disposables are cleaned up through context.subscriptions.
}
