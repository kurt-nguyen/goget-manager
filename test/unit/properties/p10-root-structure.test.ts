import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { buildInstalledTree } from '../../../src/core/installedModel';
import type { FolderGoModState, InstalledSnapshot } from '../../../src/core/installedModel';
import { NO_FOLDER, NO_GO_MOD } from '../../../src/core/messages';
import { toTreeItemProps } from '../../../src/core/treeItemProps';
import {
  snapshotArb,
  snapshotManyPresentArb,
  snapshotNoFoldersArb,
  snapshotNoPresentArb,
  snapshotOnePresentArb,
} from '../arbitraries';

// Feature: goget-manager-extension, Property 10: Root structure matches the number of go.mod files
// **Validates: Requirements 5.5, 5.7, 5.8, 7.1, 7.2**

const NUM_RUNS = 100;

type PresentState = Exclude<FolderGoModState, { kind: 'absent' }>;

const presentOf = (snapshot: InstalledSnapshot): PresentState[] =>
  snapshot.folders.filter((f): f is PresentState => f.kind !== 'absent');

/** Expected group label: module path when declared (never for readError/parseError), else folder name. */
const expectedLabel = (state: PresentState): string =>
  (state.kind === 'parsed' ? state.modulePath : undefined) ?? state.folderName;

describe('Property 10: Root structure matches the number of go.mod files', () => {
  it('zero folders: exactly one NO_FOLDER message node', () => {
    fc.assert(
      fc.property(snapshotNoFoldersArb, (snapshot) => {
        const root = buildInstalledTree(snapshot);
        expect(root).toHaveLength(1);
        expect(root[0]!.kind).toBe('message');
        expect(root[0]).toMatchObject({ text: NO_FOLDER });
        expect(NO_FOLDER).toBe('Open a folder containing a go.mod file to see installed packages.');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('folders but no go.mod: exactly one NO_GO_MOD message node', () => {
    fc.assert(
      fc.property(snapshotNoPresentArb, (snapshot) => {
        expect(snapshot.folders.length).toBeGreaterThanOrEqual(1);
        const root = buildInstalledTree(snapshot);
        expect(root).toHaveLength(1);
        expect(root[0]!.kind).toBe('message');
        expect(root[0]).toMatchObject({ text: NO_GO_MOD });
        expect(NO_GO_MOD).toBe('No go.mod file found in the current workspace.');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('exactly one present go.mod: the root contains no group nodes', () => {
    fc.assert(
      fc.property(snapshotOnePresentArb, (snapshot) => {
        expect(presentOf(snapshot)).toHaveLength(1);
        const root = buildInstalledTree(snapshot);
        expect(root.length).toBeGreaterThanOrEqual(1);
        expect(root.some((n) => n.kind === 'group')).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('two or more present go.mod files: one expanded group per file, labeled by module path or folder name', () => {
    fc.assert(
      fc.property(snapshotManyPresentArb(2), (snapshot) => {
        const present = presentOf(snapshot);
        expect(present.length).toBeGreaterThanOrEqual(2);

        const root = buildInstalledTree(snapshot);
        expect(root).toHaveLength(present.length);

        for (const node of root) {
          expect(node.kind).toBe('group');
          expect(toTreeItemProps(node).collapsibleState).toBe('expanded');
        }

        // Exactly one group per present file, with the expected label.
        const labelById = new Map(root.map((n) => [n.id, n.kind === 'group' ? n.label : undefined]));
        expect(labelById.size).toBe(present.length);
        for (const state of present) {
          expect(labelById.get(`group:${state.folderUri}`)).toBe(expectedLabel(state));
          const node = root.find((n) => n.id === `group:${state.folderUri}`);
          expect(node && toTreeItemProps(node).label).toBe(expectedLabel(state));
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('for any snapshot, the root shape follows the number of present go.mod files', () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        const root = buildInstalledTree(snapshot);
        const present = presentOf(snapshot);
        const groups = root.filter((n) => n.kind === 'group');

        if (snapshot.folders.length === 0) {
          expect(root).toEqual([expect.objectContaining({ kind: 'message', text: NO_FOLDER })]);
        } else if (present.length === 0) {
          expect(root).toEqual([expect.objectContaining({ kind: 'message', text: NO_GO_MOD })]);
        } else if (present.length === 1) {
          expect(groups).toHaveLength(0);
        } else {
          expect(root).toHaveLength(present.length);
          expect(groups).toHaveLength(present.length);
          for (const g of groups) expect(toTreeItemProps(g).collapsibleState).toBe('expanded');
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
