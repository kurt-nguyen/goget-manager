import { describe, expect, it } from 'vitest';
import * as fc from 'fast-check';
import { buildInstalledTree, type InstalledNode } from '../../../src/core/installedModel';
import { toTreeItemProps } from '../../../src/core/treeItemProps';
import { validDependencyArb } from '../arbitraries';

// Feature: goget-manager-extension, Property 11: Package tree items show path, version, and tooltip exactly
// **Validates: Requirements 5.2, 5.3, 5.6**

type PackageNode = Extract<InstalledNode, { kind: 'package' }>;

const NUM_RUNS = 200;

describe('Property 11: Package tree items show path, version, and tooltip exactly', () => {
  it('maps a package node to label=path, description=version, tooltip=path+version', () => {
    fc.assert(
      fc.property(validDependencyArb, fc.string({ maxLength: 12 }), ({ path, version }, id) => {
        const node: PackageNode = { kind: 'package', id, path, version };
        const props = toTreeItemProps(node);
        expect(props.label).toBe(path);
        expect(props.description).toBe(version);
        expect(props.tooltip).toBe(`${path} ${version}`);
        expect(props.tooltip).toContain(path);
        expect(props.tooltip).toContain(version);
        expect(props.collapsibleState).toBe('none');
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('holds for package nodes derived by buildInstalledTree from a parsed file', () => {
    fc.assert(
      fc.property(validDependencyArb, (dep) => {
        const tree = buildInstalledTree({
          folders: [
            {
              kind: 'parsed',
              folderUri: 'file:///ws/a',
              folderName: 'a',
              goModPath: '/ws/a/go.mod',
              dependencies: [dep],
            },
          ],
        });
        expect(tree).toHaveLength(1);
        const node = tree[0]!;
        expect(node.kind).toBe('package');
        const props = toTreeItemProps(node);
        expect(props.label).toBe(dep.path);
        expect(props.description).toBe(dep.version);
        expect(props.tooltip).toBe(`${dep.path} ${dep.version}`);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
