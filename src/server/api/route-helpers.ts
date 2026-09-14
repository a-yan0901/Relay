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
  lastConnectedAt: row.lastConnectedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});
