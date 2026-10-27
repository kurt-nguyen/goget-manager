import * as vscode from 'vscode';
import { GoModRepository, createDefaultDeps } from './vscode/goModRepository';
import { InstalledTreeProvider } from './vscode/installedTreeProvider';
import { DetailController } from './core/detailController';
import { collectInstalledModulePaths, isInstalledPackage } from './core/installedMatch';
import { SearchController } from './core/searchController';
import { DetailPanelManager } from './vscode/detailPanelManager';
import { PkgGoDevSearchClient, nodeHttpsTransport } from './vscode/searchClient';
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

  const searchController = new SearchController({
    client: new PkgGoDevSearchClient(nodeHttpsTransport),
    output,
    openExternal: (url) => vscode.env.openExternal(vscode.Uri.parse(url, true)),
    showError: (message) => {
      void vscode.window.showErrorMessage(message);
    },
  });
  const detailController = new DetailController({
    client: new PkgGoDevSearchClient(nodeHttpsTransport),
    output,
    isInstalled: (path) => isInstalledPackage(path, new Set(collectInstalledModulePaths(repository.snapshot()))),
  });
  const detailManager = new DetailPanelManager(context.extensionUri, detailController, (url) =>
    vscode.env.openExternal(vscode.Uri.parse(url, true)),
  );
  const installedRefresh = repository.onDidChange(() => detailController.refreshInstalled());
  const searchProvider = new SearchViewProvider(
    context.extensionUri,
    searchController,
    {
      onDidChange: repository.onDidChange,
      modules: () => collectInstalledModulePaths(repository.snapshot()),
    },
    detailManager,
  );
  const searchRegistration = vscode.window.registerWebviewViewProvider(SearchViewProvider.viewId, searchProvider, {
    webviewOptions: { retainContextWhenHidden: true },
  });

  const refreshCommand = vscode.commands.registerCommand('gogetManager.refresh', () => repository.refreshAll());

  context.subscriptions.push(
    output,
    repository,
    treeProvider,
    treeView,
    searchController,
    detailController,
    detailManager,
    installedRefresh,
    searchProvider,
    searchRegistration,
    refreshCommand,
  );

  void repository.initialize().catch((err: unknown) => {
    output.appendLine(
      `[${new Date().toISOString()}] Failed to initialize: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
    );
  });

  return createTestApi({
    treeProvider,
    treeView,
    searchProvider,
    searchController,
    testMode: context.extensionMode === vscode.ExtensionMode.Test,
  });
}

export function deactivate(): void {
  // Disposables are cleaned up through context.subscriptions.
}
