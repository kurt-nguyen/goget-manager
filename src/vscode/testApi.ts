/**
 * Small read-only inspection API returned from `activate`. The integration tests run in a
 * real VS Code host, where the tree data provider is otherwise unreachable, so they read
 * the rendered Installed tree through this API. It exposes no mutating operations.
 */

import * as vscode from 'vscode';
import type { InstalledNode } from '../core/installedModel';
import type { SearchViewModel } from '../core/searchProtocol';

/** A rendered tree row: the plain-data view of a `vscode.TreeItem` plus its children. */
export interface TreeNodeSnapshot {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly collapsibleState: 'none' | 'collapsed' | 'expanded';
  readonly children: readonly TreeNodeSnapshot[];
}

export interface GogetManagerApi {
  /** The Installed tree exactly as the tree data provider would hand it to VS Code. */
  getInstalledTree(): readonly TreeNodeSnapshot[];
  /** Whether the Installed tree view is currently visible. */
  isInstalledViewVisible(): boolean;
  /** Whether VS Code has resolved the Search webview view at least once. */
  isSearchViewResolved(): boolean;
  /** The current Search view state. */
  getSearchState(): SearchViewModel;
  /** Submits a search as if Enter was pressed. Present only when running in the Test extension mode. */
  submitSearchForTest?(text: string): void;
}

export interface TestApiSources {
  readonly treeProvider: vscode.TreeDataProvider<InstalledNode>;
  readonly treeView: { readonly visible: boolean };
  readonly searchProvider: { readonly isResolved: boolean };
  readonly searchController: { readonly state: SearchViewModel; submit(text: string): void };
  /** True only when `context.extensionMode === vscode.ExtensionMode.Test`. */
  readonly testMode: boolean;
}

function collapsibleName(state: vscode.TreeItemCollapsibleState | undefined): TreeNodeSnapshot['collapsibleState'] {
  switch (state) {
    case vscode.TreeItemCollapsibleState.Expanded:
      return 'expanded';
    case vscode.TreeItemCollapsibleState.Collapsed:
      return 'collapsed';
    default:
      return 'none';
  }
}

function textOf(value: string | vscode.MarkdownString | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return typeof value === 'string' ? value : value.value;
}

export function createTestApi(sources: TestApiSources): GogetManagerApi {
  const { treeProvider, treeView, searchProvider, searchController, testMode } = sources;

  const snapshotNodes = (nodes: readonly InstalledNode[]): TreeNodeSnapshot[] =>
    nodes.map((node) => {
      const item = treeProvider.getTreeItem(node) as vscode.TreeItem;
      const children = (treeProvider.getChildren(node) ?? []) as InstalledNode[];
      const label = typeof item.label === 'string' ? item.label : (item.label?.label ?? '');
      const description = typeof item.description === 'string' ? item.description : undefined;
      const tooltip = textOf(item.tooltip);
      return {
        label,
        ...(description !== undefined ? { description } : {}),
        ...(tooltip !== undefined ? { tooltip } : {}),
        collapsibleState: collapsibleName(item.collapsibleState),
        children: snapshotNodes(children),
      };
    });

  return {
    getInstalledTree: () => snapshotNodes((treeProvider.getChildren(undefined) ?? []) as InstalledNode[]),
    isInstalledViewVisible: () => treeView.visible,
    isSearchViewResolved: () => searchProvider.isResolved,
    getSearchState: () => searchController.state,
    ...(testMode ? { submitSearchForTest: (text: string) => searchController.submit(text) } : {}),
  };
}
