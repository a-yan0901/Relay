import { describe, expect, it } from 'vitest';

import type { GroupNode, TargetSelection } from '../../../src/shared/core/models.js';
import { dedupeTargetHostIds, groupHostIds, snapshotTargetSelection } from '../../../src/shared/core/target-selection.js';

const groups: GroupNode[] = [
  { id: 'prod', name: 'Production', parentId: null, sortOrder: 0, defaultIdentityId: null, connectionProfile: null },
  { id: 'api', name: 'API', parentId: 'prod', sortOrder: 0, defaultIdentityId: null, connectionProfile: null }
];

const hosts = [
  { id: 'host-1', groupId: 'prod', isFavorite: true },
  { id: 'host-2', groupId: 'api', isFavorite: false },
  { id: 'host-3', groupId: null, isFavorite: false }
];

describe('target selection snapshot', () => {
  it('expands nested groups, deduplicates ids, and freezes the submitted host snapshot', () => {
    expect(groupHostIds('prod', hosts, groups)).toEqual(['host-1', 'host-2']);
    expect(dedupeTargetHostIds(['host-2', 'host-1', 'host-2', 'missing'])).toEqual(['host-2', 'host-1', 'missing']);

    const selection: TargetSelection = { hostIds: ['host-1'], groupIds: ['prod'], favoriteOnly: false, query: 'api' };
    expect(snapshotTargetSelection(selection, hosts, groups)).toEqual({
      hostIds: ['host-1', 'host-2'],
      groupIds: ['prod'],
      favoriteOnly: false,
      query: 'api'
    });
  });
});
