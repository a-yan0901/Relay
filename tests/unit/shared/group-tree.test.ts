import { describe, expect, it } from 'vitest';

import { descendantGroupIds, flattenGroupTree, type GroupTreeNode } from '../../../src/shared/core/group-tree.js';

const groups: GroupTreeNode[] = [
  { id: 'prod', name: 'Production', parentId: null, sortOrder: 0 },
  { id: 'api', name: 'API', parentId: 'prod', sortOrder: 1 },
  { id: 'web', name: 'Web', parentId: 'prod', sortOrder: 0 },
  { id: 'orphan', name: 'Orphan', parentId: 'missing', sortOrder: 0 }
];

describe('shared group tree', () => {
  it('renders parents before children and keeps orphaned groups visible', () => {
    expect(flattenGroupTree(groups).map(({ group, depth }) => [group.id, depth])).toEqual([
      ['orphan', 0], ['prod', 0], ['web', 1], ['api', 1]
    ]);
  });

  it('resolves a group scope through all descendants', () => {
    expect(descendantGroupIds('prod', groups)).toEqual(['prod', 'web', 'api']);
  });
});
