import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { buildInstalledTree } from '../../../src/core/installedModel';
import type { FolderGoModState, InstalledNode, InstalledSnapshot } from '../../../src/core/installedModel';
import * as messages from '../../../src/core/messages';
import { snapshotArb, snapshotManyPresentArb, snapshotOnePresentArb } from '../arbitraries';

// Feature: goget-manager-extension, Property 8: Each go.mod file's children reflect its state
// **Validates: Requirements 5.1, 5.8, 5.9, 7.3, 7.4, 7.6**

type PresentState = Exclude<FolderGoModState, { kind: 'absent' }>;

/**
 * Nodes shown for one present file: the top level when it is the only present file,
 * otherwise the children of its `group:<folderUri>` node.
 */
function childrenOf(snapshot: InstalledSnapshot, state: PresentState): readonly InstalledNode[] {
  const root = buildInstalledTree(snapshot);
  const presentCount = snapshot.folders.filter((f) => f.kind !== 'absent').length;
  if (presentCount === 1) {
    return root;
  }
  const group = root.find((n) => n.kind === 'group' && n.id === `group:${state.folderUri}`);
  if (group === undefined || group.kind !== 'group') {
    throw new Error(`No group node for ${state.folderUri}`);
  }
  return group.children;
}

/** Canonical multiset of (path, version) pairs. */
function multiset(pairs: readonly { path: string; version: string }[]): string[] {
  return pairs.map((p) => JSON.stringify([p.path, p.version])).sort();
}

/** Checks the children of every present file in the snapshot against that file's state. */
function assertChildrenReflectState(snapshot: InstalledSnapshot): void {
  const presentStates = snapshot.folders.filter((f): f is PresentState => f.kind !== 'absent');
  for (const state of presentStates) {
    const children = childrenOf(snapshot, state);

    switch (state.kind) {
      case 'parsed': {
        if (state.dependencies.length === 0) {
          expect(children).toHaveLength(1);
          const node = children[0]!;
          expect(node.kind).toBe('message');
          expect(node.kind === 'message' && node.text).toBe(messages.NO_PACKAGES);
        } else {
          expect(children.every((n) => n.kind === 'package')).toBe(true);
          const shown = children.flatMap((n) => (n.kind === 'package' ? [n] : []));
          expect(multiset(shown)).toEqual(multiset(state.dependencies));
        }
        break;
      }
      case 'parseError': {
        expect(children).toHaveLength(1);
        const node = children[0]!;
        expect(node.kind).toBe('error');
        const text = node.kind === 'error' ? node.text : '';
        expect(text).toBe(messages.parseError(state.goModPath, state.error.line, state.error.message));
        expect(text).toContain(state.goModPath);
        expect(text).toContain(`line ${state.error.line}`);
        break;
      }
      case 'readError': {
        expect(children).toHaveLength(1);
        const node = children[0]!;
        expect(node.kind).toBe('error');
        const text = node.kind === 'error' ? node.text : '';
        expect(text).toBe(messages.readError(state.goModPath, state.reason));
        expect(text).toContain(state.goModPath);
        expect(text).toContain('Could not read');
        break;
      }
    }
  }
}

describe("Property 8: Each go.mod file's children reflect its state", () => {
  it('holds for any snapshot (top-level children when one file is present)', () => {
    fc.assert(
      fc.property(snapshotOnePresentArb, (snapshot) => {
        assertChildrenReflectState(snapshot);
      }),
      { numRuns: 150 },
    );
  });

  it('holds for any snapshot with several present files (children inside groups)', () => {
    fc.assert(
      fc.property(snapshotManyPresentArb(2), (snapshot) => {
        assertChildrenReflectState(snapshot);
      }),
      { numRuns: 150 },
    );
  });

  it('holds for arbitrary snapshots with 0..6 folders of any state', () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        if (snapshot.folders.every((f) => f.kind === 'absent')) {
          return; // no present file, nothing to check
        }
        assertChildrenReflectState(snapshot);
      }),
      { numRuns: 150 },
    );
  });
});
