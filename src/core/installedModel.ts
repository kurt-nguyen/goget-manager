/**
 * Pure display model for the Installed view. No `vscode` import.
 *
 * Turns a snapshot of per-folder go.mod states into the node tree the tree
 * provider renders: sorting, grouping, and empty/error messages live here.
 */

import { compareCodePoints } from './compare';
import type { GoModParseError, PackageDependency } from './goModParser';
import * as messages from './messages';

/** Per-folder state held by the repository. */
export type FolderGoModState =
  | { readonly kind: 'absent'; readonly folderUri: string; readonly folderName: string }
  | {
      readonly kind: 'parsed';
      readonly folderUri: string;
      readonly folderName: string;
      readonly goModPath: string;
      readonly modulePath?: string;
      readonly dependencies: readonly PackageDependency[];
    }
  | {
      readonly kind: 'parseError';
      readonly folderUri: string;
      readonly folderName: string;
      readonly goModPath: string;
      readonly modulePath?: undefined;
      readonly error: GoModParseError;
    }
  | {
      readonly kind: 'readError';
      readonly folderUri: string;
      readonly folderName: string;
      readonly goModPath: string;
      readonly reason: string;
    };

export interface InstalledSnapshot {
  /** One entry per open workspace folder, in workspace order. */
  readonly folders: readonly FolderGoModState[];
}

/** Display model produced by `buildInstalledTree`. */
export type InstalledNode =
  | { readonly kind: 'package'; readonly id: string; readonly path: string; readonly version: string }
  | {
      readonly kind: 'group';
      readonly id: string;
      readonly label: string;
      readonly goModPath: string;
      readonly children: readonly InstalledNode[];
    }
  | { readonly kind: 'message'; readonly id: string; readonly text: string }
  | { readonly kind: 'error'; readonly id: string; readonly text: string };

type PresentState = Exclude<FolderGoModState, { kind: 'absent' }>;

function messageNode(scope: string, kind: string, text: string): InstalledNode {
  return { kind: 'message', id: `msg:${scope}:${kind}`, text };
}

function errorNode(scope: string, kind: string, text: string): InstalledNode {
  return { kind: 'error', id: `msg:${scope}:${kind}`, text };
}

/** Builds the child nodes of one present go.mod file. */
function buildFileChildren(state: PresentState): readonly InstalledNode[] {
  switch (state.kind) {
    case 'parsed': {
      if (state.dependencies.length === 0) {
        return [messageNode(state.folderUri, 'no-packages', messages.NO_PACKAGES)];
      }
      // Sort by code point on path; the original index breaks ties so the sort is stable.
      return state.dependencies
        .map((dep, index) => ({ dep, index }))
        .sort((a, b) => compareCodePoints(a.dep.path, b.dep.path) || a.index - b.index)
        .map(
          ({ dep, index }): InstalledNode => ({
            kind: 'package',
            id: `pkg:${state.folderUri}:${index}:${dep.path}`,
            path: dep.path,
            version: dep.version,
          }),
        );
    }
    case 'parseError':
      return [
        errorNode(
          state.folderUri,
          'parse-error',
          messages.parseError(state.goModPath, state.error.line, state.error.message),
        ),
      ];
    case 'readError':
      return [errorNode(state.folderUri, 'read-error', messages.readError(state.goModPath, state.reason))];
  }
}

export function buildInstalledTree(snapshot: InstalledSnapshot): readonly InstalledNode[] {
  const { folders } = snapshot;

  if (folders.length === 0) {
    return [messageNode('root', 'no-folder', messages.NO_FOLDER)];
  }

  const present = folders.filter((f): f is PresentState => f.kind !== 'absent');

  if (present.length === 0) {
    return [messageNode('root', 'no-go-mod', messages.NO_GO_MOD)];
  }

  if (present.length === 1) {
    return buildFileChildren(present[0]!);
  }

  return present
    .map((state) => ({
      state,
      group: {
        kind: 'group',
        id: `group:${state.folderUri}`,
        label: (state.kind === 'readError' ? undefined : state.modulePath) ?? state.folderName,
        goModPath: state.goModPath,
        children: buildFileChildren(state),
      } satisfies InstalledNode,
    }))
    .sort(
      (a, b) =>
        compareCodePoints(a.group.label, b.group.label) ||
        compareCodePoints(a.state.folderUri, b.state.folderUri),
    )
    .map(({ group }) => group);
}
