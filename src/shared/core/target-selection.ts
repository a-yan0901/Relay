import type { BroadcastTargetSnapshot, GroupNode, TargetSelection } from './models.js';
import { descendantGroupIds } from './group-tree.js';

export interface TargetHostLike {
  id: string;
  groupId: string | null;
  isFavorite: boolean;
  name?: string;
  address?: string;
  username?: string;
  tags?: readonly string[];
}

const dedupeIds = (ids: readonly string[]): string[] => [...new Set(ids)];

export const dedupeTargetHostIds = (hostIds: readonly string[]): string[] => dedupeIds(hostIds);

export const groupHostIds = (
  groupId: string,
  hosts: readonly TargetHostLike[],
  groups: readonly GroupNode[]
): string[] => {
  const scope = new Set(descendantGroupIds(groupId, groups));
  return hosts.filter((host) => host.groupId !== null && scope.has(host.groupId)).map((host) => host.id);
};

export const snapshotTargetSelection = (
  selection: TargetSelection,
  hosts: readonly TargetHostLike[],
  groups: readonly GroupNode[]
): TargetSelection => ({
  hostIds: dedupeTargetHostIds([...selection.hostIds, ...selection.groupIds.flatMap((groupId) => groupHostIds(groupId, hosts, groups))]),
  groupIds: dedupeTargetHostIds(selection.groupIds),
  favoriteOnly: selection.favoriteOnly,
  query: selection.query
});

export const createBroadcastTargetSnapshot = (input: {
  workspaceId: string | null;
  tabIds: readonly string[];
  hostIds: readonly string[];
  capturedAt?: string;
}): BroadcastTargetSnapshot => {
  const tabIds = dedupeIds(input.tabIds);
  const hostIds = dedupeIds(input.hostIds);
  return Object.freeze({
    workspaceId: input.workspaceId,
    tabIds: Object.freeze(tabIds),
    hostIds: Object.freeze(hostIds),
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    highRisk: tabIds.length > 1
  });
};
