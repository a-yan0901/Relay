import type { FastifyRequest } from 'fastify';

import { AppError } from '../../shared/errors.js';
import type { HostMetadata } from '../../shared/validation.js';
import { getSessionId } from '../auth/session-cookie.js';
import { SessionStore, type SessionRecord } from '../auth/session-store.js';
import type { HostRow } from '../db/types.js';

export interface UnlockedSession {
  id: string;
  record: SessionRecord;
}

export const requireUnlockedSession = (request: FastifyRequest, sessionStore: SessionStore): UnlockedSession => {
  const id = getSessionId(request);
  const record = id ? sessionStore.get(id) : null;
  if (!id || !record) {
    throw new AppError('SESSION_INVALID');
  }

  return { id, record };
};

export const toHostMetadataDto = (row: HostRow | HostMetadata): HostMetadata => ({
  id: row.id,
  name: row.name,
  address: row.address,
  port: row.port,
  username: row.username,
  authType: row.authType,
  groupId: row.groupId,
  tags: [...row.tags],
  isFavorite: row.isFavorite,
  hostKeyAlgorithm: row.hostKeyAlgorithm,
  hostKeyFingerprint: row.hostKeyFingerprint,
  ...(row.jumpHostIds === undefined ? {} : { jumpHostIds: [...row.jumpHostIds] }),
  ...(row.connectionProfile === undefined ? {} : {
    connectionProfile: {
      ...row.connectionProfile,
      reconnect: { ...row.connectionProfile.reconnect }
    }
  }),
  ...(row.connectionProfileOverrides === undefined ? {} : {
    connectionProfileOverrides: row.connectionProfileOverrides === null ? null : {
      ...row.connectionProfileOverrides,
      ...(row.connectionProfileOverrides.reconnect === undefined ? {} : { reconnect: { ...row.connectionProfileOverrides.reconnect } })
    }
  }),
  ...(row.resolvedConnectionProfile === undefined ? {} : {
    resolvedConnectionProfile: {
      ...row.resolvedConnectionProfile,
      reconnect: { ...row.resolvedConnectionProfile.reconnect }
    }
  }),
  ...(row.credentialSource === undefined ? {} : {
    credentialSource: row.credentialSource,
    ...(row.identityId === undefined ? {} : { identityId: row.identityId })
  }),
  lastConnectedAt: row.lastConnectedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  ...(row.identityName === undefined ? {} : { identityName: row.identityName }),
  ...(row.identitySource === undefined ? {} : { identitySource: row.identitySource })
});
