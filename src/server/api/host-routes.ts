import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { validateJumpChain, type ConnectionProfileOverrides } from '../../shared/core/models.js';
import { resolveConnectionConfiguration } from '../../shared/core/connection-resolution.js';
import {
  parseHostCreateInput,
  parseHostPatchInput,
  defaultConnectionProfileSettings,
  mergeConnectionProfileSettings,
  storedHostCredentialSchema,
  type HostCredentialInput,
  type StoredHostCredential,
  type HostCreateInput,
  type HostMetadata
} from '../../shared/validation.js';
import { SessionStore } from '../auth/session-store.js';
import { VaultService, type EncryptedJson } from '../vault/vault-service.js';
import { AuditRepository, HostRepository } from '../db/repositories.js';
import type { GroupRepository } from '../db/repositories.js';
import type { HostPatch } from '../db/types.js';
import type { SshConnectConfig, SshHostKeyChallenge, SshSessionManagerPort } from '../ssh/types.js';
import { HostKeyPolicy } from '../ssh/host-key-policy.js';
import { IdentityService } from '../identity/identity-service.js';
import { TerminalProfileService } from '../terminal/terminal-profile-service.js';
import { requireUnlockedSession, toHostMetadataDto } from './route-helpers.js';
import type { IdentityMetadata } from '../../shared/core/models.js';
import type { SyncCoordinatorPort } from '../sync/sync-service.js';

export interface HostRouteDependencies {
  ownerId: string;
  hostRepository: HostRepository;
  groupRepository?: GroupRepository;
  sessionStore: SessionStore;
  vaultService: VaultService;
  auditRepository: AuditRepository;
  identityService?: IdentityService;
  terminalProfileService?: TerminalProfileService;
  sshSessionManager?: SshSessionManagerPort;
  syncCoordinator?: SyncCoordinatorPort;
}

const hostListQuerySchema = z.object({
  query: z.string().max(128).optional(),
  groupId: z.string().min(1).max(128).optional(),
  favorite: z.enum(['true', 'false']).transform((value) => value === 'true').optional()
}).strict();

const paramsSchema = z.object({ id: z.string().min(1).max(128) }).strict();

const hostId = (params: unknown): string => {
  const parsed = paramsSchema.safeParse(params);
  if (!parsed.success) {
    throw new AppError('HOST_NOT_FOUND');
  }
  return parsed.data.id;
};

const credentialAad = (id: string): string => `host:${id}:credentials:v1`;

const serializeEncryptedCredential = (value: EncryptedJson): string => JSON.stringify(value);

const parseEncryptedCredential = (value: string): EncryptedJson => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      !('nonce' in parsed) ||
      !('ciphertext' in parsed) ||
      !('authTag' in parsed) ||
      !('aad' in parsed)
    ) {
      throw new Error('invalid credential blob');
    }

    return parsed as EncryptedJson;
  } catch {
    throw new AppError('VAULT_CRYPTO_FAILED');
  }
};

const mergeConnectionProfileOverrides = (
  current: ConnectionProfileOverrides | null | undefined,
  patch: ConnectionProfileOverrides
): ConnectionProfileOverrides => ({
  ...(current ?? {}),
  ...patch,
  ...((current?.reconnect !== undefined || patch.reconnect !== undefined)
    ? { reconnect: { ...(current?.reconnect ?? {}), ...(patch.reconnect ?? {}) } }
    : {})
});

const readHost = (dependencies: HostRouteDependencies, id: string) => {
  const row = dependencies.hostRepository.getForConnection(id);
  if (!row) {
    throw new AppError('HOST_NOT_FOUND');
  }
  return row;
};

const enrichHostMetadata = async (
  dependencies: HostRouteDependencies,
  row: HostMetadata
): Promise<HostMetadata> => {
  const metadata = toHostMetadataDto(row);
  const resolved = resolveConnectionConfiguration(metadata, dependencies.groupRepository?.list() ?? []);
  const identity = resolved.identityId && dependencies.identityService
    ? await dependencies.identityService.get(dependencies.ownerId, resolved.identityId)
    : null;
  return {
    ...metadata,
    ...(identity ? { authType: identity.type } : {}),
    resolvedConnectionProfile: resolved.profile,
    identityName: identity?.name ?? null,
    identitySource: resolved.identitySource
  };
};

const requireGroupIdentity = async (
  dependencies: HostRouteDependencies,
  groupId: string | null | undefined
): Promise<IdentityMetadata> => {
  if (!groupId || !dependencies.identityService) throw new AppError('IDENTITY_NOT_FOUND');
  const resolved = resolveConnectionConfiguration({ groupId }, dependencies.groupRepository?.list() ?? []);
  if (!resolved.identityId) throw new AppError('IDENTITY_NOT_FOUND');
  const identity = await dependencies.identityService.get(dependencies.ownerId, resolved.identityId);
  if (!identity) throw new AppError('IDENTITY_NOT_FOUND');
  return identity;
};

const validateJumpHostGraph = (
  dependencies: HostRouteDependencies,
  targetHostId: string,
  jumpHostIds: readonly string[]
): void => {
  const profiles = new Map(
    dependencies.hostRepository.listMetadata().map((host) => [host.id, { jumpHostIds: host.jumpHostIds ?? [] }])
  );
  profiles.set(targetHostId, { jumpHostIds: [...jumpHostIds] });
  try {
    validateJumpChain(targetHostId, profiles);
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) {
      throw new AppError('HOST_NOT_FOUND');
    }
    throw new AppError('HOST_VALIDATION_FAILED');
  }
};

const decryptHostCredential = async (
  dependencies: HostRouteDependencies,
  sessionKey: Buffer,
  row: ReturnType<HostRepository['getForConnection']> extends infer T ? Exclude<T, null> : never
): Promise<HostCredentialInput> => {
  const resolved = resolveConnectionConfiguration(row, dependencies.groupRepository?.list() ?? []);
  const identityId = row.credentialSource?.type === 'identity'
    ? row.identityId
    : row.credentialSource?.type === 'group' ? resolved.identityId : null;
  if (identityId) {
    if (!dependencies.identityService) throw new AppError('IDENTITY_NOT_FOUND');
    const credential = await dependencies.identityService.getCredential(dependencies.ownerId, identityId, sessionKey);
    if (credential.type === 'pending') throw new AppError('IMPORT_RECORD_INVALID', '请先在连接时补录凭据');
    return credential;
  }
  if (row.credentialSource?.type === 'group') throw new AppError('IDENTITY_NOT_FOUND');
  if (row.credentialCiphertext === null) throw new AppError('IMPORT_RECORD_INVALID', '请先在连接时补录凭据');
  const stored = await dependencies.vaultService.decryptJson<StoredHostCredential>(
    sessionKey,
    credentialAad(row.id),
    parseEncryptedCredential(row.credentialCiphertext)
  );
  const parsed = storedHostCredentialSchema.safeParse(stored);
  if (!parsed.success || parsed.data.type === 'pending') throw new AppError('IMPORT_RECORD_INVALID', '请先在连接时补录凭据');
  return parsed.data;
};

const toSshConfig = async (
  dependencies: HostRouteDependencies,
  sessionKey: Buffer,
  row: Exclude<ReturnType<HostRepository['getForConnection']>, null>
): Promise<SshConnectConfig> => {
  const resolved = resolveConnectionConfiguration({
    groupId: row.groupId,
    connectionProfile: row.connectionProfile,
    connectionProfileOverrides: row.connectionProfileOverrides,
    credentialSource: row.credentialSource
  }, dependencies.groupRepository?.list() ?? []).profile;
  return {
    hostId: row.id,
    address: row.address,
    port: row.port,
    username: row.username,
    auth: await decryptHostCredential(dependencies, sessionKey, row),
    hostKeyAlgorithm: row.hostKeyAlgorithm,
    hostKeyFingerprint: row.hostKeyFingerprint,
    keepaliveInterval: resolved.keepaliveIntervalMs,
    keepaliveCountMax: resolved.keepaliveCountMax,
    reconnect: resolved.reconnect
  };
};

export const registerHostRoutes = async (
  app: FastifyInstance,
  dependencies: HostRouteDependencies
): Promise<void> => {
  app.get('/api/hosts', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    let filter: z.infer<typeof hostListQuerySchema>;
    try {
      filter = hostListQuerySchema.parse(request.query);
    } catch {
      throw new AppError('HOST_VALIDATION_FAILED');
    }
    const hosts = dependencies.hostRepository.listMetadata(filter);
    reply.send(await Promise.all(hosts.map((host) => enrichHostMetadata(dependencies, host))));
  });

  app.get('/api/hosts/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    reply.send(await enrichHostMetadata(dependencies, readHost(dependencies, hostId(request.params))));
  });

  app.post('/api/hosts', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const input: HostCreateInput = parseHostCreateInput(request.body);
    const id = randomUUID();
    validateJumpHostGraph(dependencies, id, input.jumpHostIds);
    let authType: HostCredentialInput['type'];
    let credentialCiphertext: string | null = null;
    let credentialSource: 'inline' | 'identity' | 'group' = 'inline';
    let identityId: string | null = null;
    if (input.credentialSource?.type === 'identity') {
      const identity = await dependencies.identityService?.get(dependencies.ownerId, input.credentialSource.identityId);
      if (!identity) throw new AppError('IDENTITY_NOT_FOUND');
      authType = identity.type;
      credentialSource = 'identity';
      identityId = identity.id;
    } else if (input.credentialSource?.type === 'group') {
      const identity = await requireGroupIdentity(dependencies, input.groupId);
      authType = identity.type;
      credentialSource = 'group';
    } else {
      if (!input.auth) throw new AppError('HOST_VALIDATION_FAILED');
      const encrypted = await dependencies.vaultService.encryptJson(
        session.record.vaultKey,
        credentialAad(id),
        input.auth
      );
      authType = input.auth.type;
      credentialCiphertext = serializeEncryptedCredential(encrypted);
    }
    if (input.terminalProfileId !== undefined && input.terminalProfileId !== null && !dependencies.terminalProfileService?.get(dependencies.ownerId, input.terminalProfileId)) throw new AppError('NOT_FOUND');
    const created = dependencies.hostRepository.createHost({
      id,
      ownerId: dependencies.ownerId,
      name: input.name,
      address: input.address,
      port: input.port,
      username: input.username,
      authType,
      credentialCiphertext,
      credentialVersion: 1,
      credentialSource,
      identityId,
      hostKeyAlgorithm: null,
      hostKeyFingerprint: null,
      groupId: input.groupId ?? null,
      terminalProfileId: input.terminalProfileId ?? null,
      jumpHostIds: input.jumpHostIds,
      connectionProfile: mergeConnectionProfileSettings(input.connectionProfile),
      connectionProfileOverrides: input.connectionProfile ?? null,
      tags: input.tags,
      isFavorite: input.isFavorite,
      lastConnectedAt: null
    });
    dependencies.auditRepository.insert({ eventType: 'host_created', hostId: id, requestId: request.id });
    dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId);
    reply.code(201).send(await enrichHostMetadata(dependencies, created));
  });

  app.patch('/api/hosts/:id', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const id = hostId(request.params);
    const current = readHost(dependencies, id);
    const input = parseHostPatchInput(request.body);
    if (input.terminalProfileId !== undefined && input.terminalProfileId !== null && !dependencies.terminalProfileService?.get(dependencies.ownerId, input.terminalProfileId)) throw new AppError('NOT_FOUND');
    if (input.jumpHostIds !== undefined) validateJumpHostGraph(dependencies, id, input.jumpHostIds);
    const patch: HostPatch = {
      name: input.name,
      address: input.address,
      port: input.port,
      username: input.username,
      groupId: input.groupId,
      terminalProfileId: input.terminalProfileId,
      jumpHostIds: input.jumpHostIds,
      tags: input.tags,
      isFavorite: input.isFavorite
    };
    const nextGroupId = input.groupId === undefined ? current.groupId : input.groupId;
    if (input.connectionProfile !== undefined) {
      const connectionProfileOverrides = mergeConnectionProfileOverrides(current.connectionProfileOverrides, input.connectionProfile);
      patch.connectionProfile = mergeConnectionProfileSettings(connectionProfileOverrides, current.connectionProfile ?? defaultConnectionProfileSettings());
      patch.connectionProfileOverrides = connectionProfileOverrides;
    }
    const nextCredentialSource = input.credentialSource?.type ?? current.credentialSource?.type;
    if (input.credentialSource?.type === 'identity') {
      const identity = await dependencies.identityService?.get(dependencies.ownerId, input.credentialSource.identityId);
      if (!identity) throw new AppError('IDENTITY_NOT_FOUND');
      patch.authType = identity.type;
      patch.credentialSource = 'identity';
      patch.identityId = identity.id;
      patch.credentialCiphertext = null;
      patch.credentialVersion = 1;
    } else if (input.auth !== undefined) {
      const encrypted = await dependencies.vaultService.encryptJson(
        session.record.vaultKey,
        credentialAad(id),
        input.auth
      );
      patch.authType = input.auth.type;
      patch.credentialCiphertext = serializeEncryptedCredential(encrypted);
      patch.credentialVersion = 1;
      patch.credentialSource = 'inline';
      patch.identityId = null;
    } else if (nextCredentialSource === 'group') {
      const identity = await requireGroupIdentity(dependencies, nextGroupId);
      patch.authType = identity.type;
      patch.credentialSource = 'group';
      patch.identityId = null;
      patch.credentialCiphertext = null;
      patch.credentialVersion = 1;
    }

    const updated = dependencies.hostRepository.updateHost(id, patch);
    dependencies.auditRepository.insert({ eventType: 'host_updated', hostId: id, requestId: request.id });
    dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId);
    reply.send(await enrichHostMetadata(dependencies, updated));
  });

  app.delete('/api/hosts/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const id = hostId(request.params);
    readHost(dependencies, id);
    dependencies.hostRepository.deleteHost(id);
    dependencies.sshSessionManager?.closeForHost?.(id);
    dependencies.auditRepository.insert({ eventType: 'host_deleted', requestId: request.id });
    dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId);
    reply.code(204).send();
  });

  app.delete('/api/hosts/:id/host-key', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const id = hostId(request.params);
    readHost(dependencies, id);
    dependencies.hostRepository.clearHostKey(id);
    dependencies.auditRepository.insert({ eventType: 'host_key_cleared', hostId: id, requestId: request.id });
    dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId);
    reply.code(204).send();
  });

  app.post('/api/hosts/:id/test-connection', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    if (!dependencies.sshSessionManager) {
      throw new AppError('SSH_CONNECTION_FAILED');
    }

    const id = hostId(request.params);
    const row = readHost(dependencies, id);
    const hostKeyPolicy = new HostKeyPolicy({
      hostId: row.id,
      address: row.address,
      port: row.port,
      knownHostKey: row.hostKeyAlgorithm && row.hostKeyFingerprint
        ? { algorithm: row.hostKeyAlgorithm, fingerprint: row.hostKeyFingerprint }
        : null,
      saveHostKey: (hostId, algorithm, fingerprint) => dependencies.hostRepository.setHostKey(hostId, algorithm, fingerprint)
    });
    let challenge: SshHostKeyChallenge | undefined;
    const result = await dependencies.sshSessionManager.testConnection(
      await toSshConfig(dependencies, session.record.vaultKey, row),
      {
        onHostKey: async (nextChallenge) => {
          let accepted: boolean | undefined;
          hostKeyPolicy.verifyFingerprint(nextChallenge.fingerprint, nextChallenge.algorithm, (resultValue) => {
            accepted = resultValue;
          });
          if (accepted !== true) challenge = hostKeyPolicy.pendingChallenge ?? nextChallenge;
          return accepted === true;
        }
      }
    );

    if (challenge || result.hostKey) {
      reply.code(409).send({ ok: false, hostKey: challenge ?? result.hostKey });
      return;
    }

    if (result.ok) {
      dependencies.syncCoordinator?.markDirtyFromRequest(request, dependencies.ownerId);
      reply.send({ ok: true });
      return;
    }

    throw new AppError('SSH_CONNECTION_FAILED');
  });
};
