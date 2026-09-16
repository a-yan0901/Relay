import type { GroupNode, TargetSelection } from './models.js';
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

export const dedupeTargetHostIds = (hostIds: readonly string[]): string[] => [...new Set(hostIds)];

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
