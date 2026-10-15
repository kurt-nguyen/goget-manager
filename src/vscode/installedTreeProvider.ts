/**
 * Tree data provider for the "Installed" view. All display decisions live in the
 * pure core (`buildInstalledTree`, `toTreeItemProps`); this class caches the model
 * and maps plain props onto `vscode.TreeItem`.
 */

import * as vscode from 'vscode';
import { buildInstalledTree } from '../core/installedModel';
import type { InstalledNode, InstalledSnapshot } from '../core/installedModel';
import { toTreeItemProps } from '../core/treeItemProps';

/** The slice of `GoModRepository` the tree provider needs. */
export interface InstalledRepository {
  readonly onDidChange: vscode.Event<void>;
  snapshot(): InstalledSnapshot;
}

export class InstalledTreeProvider implements vscode.TreeDataProvider<InstalledNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly subscription: vscode.Disposable;
  private cache: readonly InstalledNode[] | undefined;

  readonly onDidChangeTreeData: vscode.Event<void> = this.emitter.event;

  constructor(private readonly repo: InstalledRepository) {
    this.subscription = repo.onDidChange(() => {
      this.cache = undefined;
      this.emitter.fire();
    });
  }

  /** Never throws: any failure while building the model becomes a single error node. */
  getChildren(element?: InstalledNode): InstalledNode[] {
    try {
      if (element) {
        return element.kind === 'group' ? [...element.children] : [];
      }
      this.cache ??= buildInstalledTree(this.repo.snapshot());
      return [...this.cache];
    } catch (err) {
      this.cache = undefined;
      const reason = err instanceof Error ? err.message : String(err);
      return [{ kind: 'error', id: 'msg:root:internal-error', text: `Could not build the installed packages list: ${reason}` }];
    }
  }

  getTreeItem(node: InstalledNode): vscode.TreeItem {
    const props = toTreeItemProps(node);
    const item = new vscode.TreeItem(
      props.label,
      props.collapsibleState === 'expanded'
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    item.id = node.id;
    item.iconPath = new vscode.ThemeIcon(props.iconId);
    if (props.description !== undefined) {
      item.description = props.description;
    }
    if (props.tooltip !== undefined) {
      item.tooltip = props.tooltip;
    }
    return item;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
