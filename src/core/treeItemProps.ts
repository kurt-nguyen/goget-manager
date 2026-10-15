/**
 * Pure mapping from display-model nodes to plain tree item properties.
 * No `vscode` import: the tree provider converts these into a `vscode.TreeItem`.
 */

import type { InstalledNode } from './installedModel';

export type TreeItemCollapsibleStateName = 'none' | 'expanded';

export type TreeItemIconId = 'package' | 'folder' | 'info' | 'error';

export interface TreeItemProps {
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly collapsibleState: TreeItemCollapsibleStateName;
  readonly iconId: TreeItemIconId;
}

export function toTreeItemProps(node: InstalledNode): TreeItemProps {
  switch (node.kind) {
    case 'package':
      return {
        label: node.path,
        description: node.version,
        tooltip: `${node.path} ${node.version}`,
        collapsibleState: 'none',
        iconId: 'package',
      };
    case 'group':
      return {
        label: node.label,
        tooltip: node.goModPath,
        collapsibleState: 'expanded',
        iconId: 'folder',
      };
    case 'message':
      return {
        label: node.text,
        collapsibleState: 'none',
        iconId: 'info',
      };
    case 'error':
      return {
        label: node.text,
        tooltip: node.text,
        collapsibleState: 'none',
        iconId: 'error',
      };
  }
}
