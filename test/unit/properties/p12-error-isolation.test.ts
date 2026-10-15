import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { buildInstalledTree, type InstalledNode } from '../../../src/core/installedModel';
import { snapshotWithErrorMutationArb } from '../arbitraries';

// Feature: goget-manager-extension, Property 12: Errors in one go.mod file do not affect other files
// **Validates: Requirements 5.9, 6.6, 7.7**

type GroupNode = Extract<InstalledNode, { kind: 'group' }>;

const NUM_RUNS = 200;

/** Groups at the root, keyed by id (group order may change when the mutated file's label changes). */
function groupsById(tree: readonly InstalledNode[]): Map<string, GroupNode> {
  const map = new Map<string, GroupNode>();
  for (const node of tree) {
    if (node.kind === 'group') {
      map.set(node.id, node);
    }
  }
  return map;
}

describe('Property 12: Errors in one go.mod file do not affect other files', () => {
  it('leaves the group and subtree of every other file identical and shows an error in the mutated group', () => {
    fc.assert(
      fc.property(snapshotWithErrorMutationArb(2), ({ snapshot, index, replacement, mutated }) => {
        const before = groupsById(buildInstalledTree(snapshot));
        const after = groupsById(buildInstalledTree(mutated));
        const targetId = `group:${snapshot.folders[index]!.folderUri}`;

        // Both trees have one group per present file.
        expect(after.size).toBe(before.size);
        expect([...after.keys()].sort()).toEqual([...before.keys()].sort());

        // Every other file's group is deeply equal (ids, labels, children).
        for (const [id, group] of before) {
          if (id !== targetId) {
            expect(after.get(id)).toEqual(group);
          }
        }

        // The mutated file's group now holds exactly one error node.
        const target = after.get(targetId);
        expect(target).toBeDefined();
        expect(replacement.kind === 'parseError' || replacement.kind === 'readError').toBe(true);
        expect(target!.children).toHaveLength(1);
        expect(target!.children[0]!.kind).toBe('error');
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
