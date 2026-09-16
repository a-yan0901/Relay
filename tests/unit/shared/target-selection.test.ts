import { describe, expect, it } from 'vitest';

import type { GroupNode, TargetSelection } from '../../../src/shared/core/models.js';
import { createBroadcastTargetSnapshot, createTargetSelectionSnapshot, dedupeTargetHostIds, groupHostIds, snapshotTargetSelection } from '../../../src/shared/core/target-selection.js';

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

  it('freezes a deduplicated broadcast target snapshot with an explicit risk marker', () => {
    const snapshot = createBroadcastTargetSnapshot({
      workspaceId: 'workspace-1',
      tabIds: ['tab-1', 'tab-1', 'tab-2'],
      hostIds: ['host-1', 'host-2', 'host-1'],
      capturedAt: '2026-09-16T09:00:00.000Z'
    });

    expect(snapshot).toEqual({
      workspaceId: 'workspace-1',
      tabIds: ['tab-1', 'tab-2'],
      hostIds: ['host-1', 'host-2'],
      capturedAt: '2026-09-16T09:00:00.000Z',
      highRisk: true
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.tabIds)).toBe(true);
    expect(Object.isFrozen(snapshot.hostIds)).toBe(true);
  });

  it('captures the active source and display names without trusting later host-list changes', () => {
    const snapshot = createTargetSelectionSnapshot(
      { hostIds: ['host-1', 'host-1'], groupIds: [], favoriteOnly: false, query: '', source: 'favorites' },
      [
        { id: 'host-1', name: 'Production API', groupId: null, isFavorite: true },
        { id: 'host-2', name: 'Staging API', groupId: null, isFavorite: false }
      ],
      [],
      '2026-09-16T09:00:00.000Z'
    );

    expect(snapshot).toEqual({
      hostIds: ['host-1'],
      source: 'favorites',
      capturedAt: '2026-09-16T09:00:00.000Z',
      displayNames: ['Production API']
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.hostIds)).toBe(true);
    expect(Object.isFrozen(snapshot.displayNames)).toBe(true);
  });
});
