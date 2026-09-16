import { AppError } from '../errors.js';
import {
  defaultConnectionProfileSettings,
  mergeConnectionProfileSettings,
  type ConnectionProfileSettings,
  type HostCredentialSource,
  type HostMetadata
} from '../validation.js';
import type { ConnectionProfileOverrides, GroupNode, IdentitySource } from './models.js';

export const MAX_GROUP_DEPTH = 8;

export interface ConnectionResolutionHost {
  groupId: string | null | undefined;
  connectionProfile?: ConnectionProfileOverrides | ConnectionProfileSettings | null;
  connectionProfileOverrides?: ConnectionProfileOverrides | null;
  credentialSource?: HostCredentialSource;
}

export interface ResolvedConnectionConfiguration {
  profile: ConnectionProfileSettings;
  groupChain: readonly GroupNode[];
  identityId: string | null;
  identitySource: IdentitySource;
}

const groupsById = (groups: readonly GroupNode[]): Map<string, GroupNode> => {
  const result = new Map<string, GroupNode>();
  for (const group of groups) {
    if (result.has(group.id)) throw new AppError('GROUP_CYCLE');
    result.set(group.id, group);
  }
  return result;
};

const resolveGroupChain = (groupId: string | null | undefined, groups: readonly GroupNode[]): GroupNode[] => {
  if (!groupId) return [];
  const byId = groupsById(groups);
  const chain: GroupNode[] = [];
  const active = new Set<string>();
  let currentId: string | null = groupId;
  while (currentId !== null) {
    if (active.has(currentId)) throw new AppError('GROUP_CYCLE');
    const group = byId.get(currentId);
    if (!group) throw new AppError('GROUP_NOT_FOUND');
    active.add(currentId);
    chain.push(group);
    if (chain.length > MAX_GROUP_DEPTH) throw new AppError('GROUP_DEPTH_EXCEEDED');
    currentId = group.parentId;
  }
  return chain.reverse();
};

export const resolveConnectionConfiguration = (
  host: ConnectionResolutionHost | Pick<HostMetadata, 'groupId' | 'connectionProfile' | 'connectionProfileOverrides' | 'credentialSource'>,
  groups: readonly GroupNode[]
): ResolvedConnectionConfiguration => {
  const groupChain = resolveGroupChain(host.groupId, groups);
  let profile = defaultConnectionProfileSettings();
  for (const group of groupChain) profile = mergeConnectionProfileSettings(group.connectionProfile ?? undefined, profile);
  const explicitProfile = host.connectionProfileOverrides === undefined
    ? host.connectionProfile
    : host.connectionProfileOverrides;
  profile = mergeConnectionProfileSettings(explicitProfile ?? undefined, profile);

  if (host.credentialSource?.type === 'identity') {
    return { profile, groupChain, identityId: host.credentialSource.identityId, identitySource: 'host' };
  }
  if (host.credentialSource?.type === 'inline') {
    return { profile, groupChain, identityId: null, identitySource: 'host' };
  }
  for (const group of [...groupChain].reverse()) {
    if (group.defaultIdentityId) return { profile, groupChain, identityId: group.defaultIdentityId, identitySource: 'group' };
  }
  return { profile, groupChain, identityId: null, identitySource: 'none' };
};
