import type { GroupNode } from './models.js';

/** The smallest cross-client shape needed to render and resolve a group tree. */
export type GroupTreeNode = Pick<GroupNode, 'id' | 'name' | 'sortOrder'> & {
  parentId?: string | null;
};

export interface GroupTreeRow<T extends GroupTreeNode = GroupTreeNode> {
  group: T;
  depth: number;
}

const compareGroups = <T extends GroupTreeNode>(left: T, right: T): number => (
  left.sortOrder - right.sortOrder || left.name.localeCompare(right.name) || left.id.localeCompare(right.id)
);

/**
 * Returns a deterministic, cycle-safe pre-order tree for any client renderer.
 * Orphaned groups are kept visible as roots instead of disappearing.
 */
export const flattenGroupTree = <T extends GroupTreeNode>(groups: readonly T[]): GroupTreeRow<T>[] => {
  const byParent = new Map<string | null, T[]>();
  const byId = new Map(groups.map((group) => [group.id, group]));
  for (const group of groups) {
    const parentId = group.parentId && byId.has(group.parentId) ? group.parentId : null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(group);
    byParent.set(parentId, siblings);
  }
  for (const siblings of byParent.values()) siblings.sort(compareGroups);

  const rows: GroupTreeRow<T>[] = [];
  const rendered = new Set<string>();
  const visit = (group: T, depth: number, path: ReadonlySet<string>): void => {
    if (path.has(group.id) || rendered.has(group.id)) return;
    rendered.add(group.id);
    rows.push({ group, depth });
    const nextPath = new Set(path).add(group.id);
    for (const child of byParent.get(group.id) ?? []) visit(child, Math.min(depth + 1, 8), nextPath);
  };

  for (const root of byParent.get(null) ?? []) visit(root, 0, new Set());
  for (const group of [...groups].sort(compareGroups)) if (!rendered.has(group.id)) visit(group, 0, new Set());
  return rows;
};

export const descendantGroupIds = (
  rootId: string,
  groups: readonly GroupTreeNode[]
): string[] => flattenGroupTree(groups)
  .filter(({ group }) => group.id === rootId || isDescendant(group.id, rootId, groups))
  .map(({ group }) => group.id);

const isDescendant = (groupId: string, rootId: string, groups: readonly GroupTreeNode[]): boolean => {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const visited = new Set<string>();
  let currentId = byId.get(groupId)?.parentId ?? null;
  while (currentId !== null) {
    if (currentId === rootId) return true;
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    currentId = byId.get(currentId)?.parentId ?? null;
  }
  return false;
};
