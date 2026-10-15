import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { compareCodePoints } from '../../../src/core/compare';
import { buildInstalledTree, type InstalledNode } from '../../../src/core/installedModel';
import { snapshotArb, snapshotManyPresentArb } from '../arbitraries';

// Feature: goget-manager-extension, Property 9: Package and group nodes are sorted by code point
// **Validates: Requirements 5.4**

type PackageNode = Extract<InstalledNode, { kind: 'package' }>;
type GroupNode = Extract<InstalledNode, { kind: 'group' }>;

const NUM_RUNS = 200;

/** Every list of sibling nodes in the tree: the root list and each group's children. */
function siblingLists(root: readonly InstalledNode[]): (readonly InstalledNode[])[] {
  const lists: (readonly InstalledNode[])[] = [root];
  for (const node of root) {
    if (node.kind === 'group') {
      lists.push(...siblingLists(node.children));
    }
  }
  return lists;
}

function expectNonDecreasing(values: readonly string[]): void {
  for (let i = 1; i < values.length; i++) {
    expect(compareCodePoints(values[i - 1]!, values[i]!)).toBeLessThanOrEqual(0);
  }
}

describe('Property 9: Package and group nodes are sorted by code point', () => {
  it('sorts every list of sibling package nodes by path', () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        for (const list of siblingLists(buildInstalledTree(snapshot))) {
          const packages = list.filter((n): n is PackageNode => n.kind === 'package');
          expectNonDecreasing(packages.map((p) => p.path));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('sorts root group nodes by label', () => {
    fc.assert(
      fc.property(snapshotManyPresentArb(2), (snapshot) => {
        const groups = buildInstalledTree(snapshot).filter((n): n is GroupNode => n.kind === 'group');
        expect(groups.length).toBeGreaterThanOrEqual(2);
        expectNonDecreasing(groups.map((g) => g.label));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('keeps dependencies with equal paths in their original file order', () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        const tree = buildInstalledTree(snapshot);
        const present = snapshot.folders.filter((f) => f.kind !== 'absent');
        for (const state of present) {
          if (state.kind !== 'parsed' || state.dependencies.length === 0) {
            continue;
          }
          const siblings =
            present.length === 1
              ? tree
              : (tree.find((n) => n.kind === 'group' && n.id === `group:${state.folderUri}`) as GroupNode).children;
          const shown = siblings.filter((n): n is PackageNode => n.kind === 'package');
          expect(shown).toHaveLength(state.dependencies.length);
          for (const path of new Set(state.dependencies.map((d) => d.path))) {
            const expected = state.dependencies.filter((d) => d.path === path).map((d) => d.version);
            const actual = shown.filter((p) => p.path === path).map((p) => p.version);
            expect(actual).toEqual(expected);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('orders astral-plane paths after high BMP paths', () => {
    const tree = buildInstalledTree({
      folders: [
        {
          kind: 'parsed',
          folderUri: 'file:///ws/a',
          folderName: 'a',
          goModPath: '/ws/a/go.mod',
          dependencies: [
            { path: '\u{1F600}', version: 'v1.0.0' },
            { path: '\uFF5E', version: 'v1.0.0' },
            { path: 'z', version: 'v1.0.0' },
          ],
        },
      ],
    });
    expect(tree.map((n) => (n.kind === 'package' ? n.path : ''))).toEqual(['z', '\uFF5E', '\u{1F600}']);
  });
});
