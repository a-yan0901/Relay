import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import {
  parseHostCreateInput,
  parseHostPatchInput,
  type HostCredentialInput,
  type HostCreateInput
} from '../../shared/validation.js';
import { SessionStore } from '../auth/session-store.js';
import { VaultService, type EncryptedJson } from '../vault/vault-service.js';
import { AuditRepository, HostRepository } from '../db/repositories.js';
import type { HostPatch } from '../db/types.js';
import type { SshConnectConfig, SshHostKeyChallenge, SshSessionManagerPort } from '../ssh/types.js';
import { requireUnlockedSession, toHostMetadataDto } from './route-helpers.js';

export interface HostRouteDependencies {
  ownerId: string;
  hostRepository: HostRepository;
  sessionStore: SessionStore;
  vaultService: VaultService;
  auditRepository: AuditRepository;
  sshSessionManager?: SshSessionManagerPort;
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

const readHost = (dependencies: HostRouteDependencies, id: string) => {
  const row = dependencies.hostRepository.getForConnection(id);
  if (!row) {
    throw new AppError('HOST_NOT_FOUND');
  }
  return row;
};

const decryptHostCredential = async (
  dependencies: HostRouteDependencies,
  sessionKey: Buffer,
  row: ReturnType<HostRepository['getForConnection']> extends infer T ? Exclude<T, null> : never
): Promise<HostCredentialInput> => dependencies.vaultService.decryptJson<HostCredentialInput>(
  sessionKey,
  credentialAad(row.id),
  parseEncryptedCredential(row.credentialCiphertext)
);

const toSshConfig = async (
  dependencies: HostRouteDependencies,
  sessionKey: Buffer,
  row: Exclude<ReturnType<HostRepository['getForConnection']>, null>
): Promise<SshConnectConfig> => ({
  hostId: row.id,
  address: row.address,
  port: row.port,
  username: row.username,
  auth: await decryptHostCredential(dependencies, sessionKey, row),
  hostKeyAlgorithm: row.hostKeyAlgorithm,
  hostKeyFingerprint: row.hostKeyFingerprint
});

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
    reply.send(dependencies.hostRepository.listMetadata(filter));
  });

  app.get('/api/hosts/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    reply.send(toHostMetadataDto(readHost(dependencies, hostId(request.params))));
  });

  app.post('/api/hosts', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const input: HostCreateInput = parseHostCreateInput(request.body);
    const id = randomUUID();
    const encrypted = await dependencies.vaultService.encryptJson(
      session.record.vaultKey,
      credentialAad(id),
      input.auth
    );
    const created = dependencies.hostRepository.createHost({
      id,
      ownerId: dependencies.ownerId,
      name: input.name,
      address: input.address,
      port: input.port,
      username: input.username,
      authType: input.auth.type,
      credentialCiphertext: serializeEncryptedCredential(encrypted),
      credentialVersion: 1,
      hostKeyAlgorithm: null,
      hostKeyFingerprint: null,
      groupId: input.groupId ?? null,
      tags: input.tags,
      isFavorite: input.isFavorite,
      lastConnectedAt: null
    });
    dependencies.auditRepository.insert({ eventType: 'host_created', hostId: id, requestId: request.id });
    reply.code(201).send(toHostMetadataDto(created));
  });

  app.patch('/api/hosts/:id', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    const id = hostId(request.params);
    readHost(dependencies, id);
    const input = parseHostPatchInput(request.body);
    const patch: HostPatch = {
      name: input.name,
      address: input.address,
      port: input.port,
      username: input.username,
      groupId: input.groupId,
      tags: input.tags,
      isFavorite: input.isFavorite
    };
    if (input.auth !== undefined) {
      const encrypted = await dependencies.vaultService.encryptJson(
        session.record.vaultKey,
        credentialAad(id),
        input.auth
      );
      patch.authType = input.auth.type;
      patch.credentialCiphertext = serializeEncryptedCredential(encrypted);
      patch.credentialVersion = 1;
    }

    const updated = dependencies.hostRepository.updateHost(id, patch);
    dependencies.auditRepository.insert({ eventType: 'host_updated', hostId: id, requestId: request.id });
    reply.send(toHostMetadataDto(updated));
  });

  app.delete('/api/hosts/:id', async (request, reply) => {
    requireUnlockedSession(request, dependencies.sessionStore);
    const id = hostId(request.params);
    readHost(dependencies, id);
    dependencies.hostRepository.deleteHost(id);
    dependencies.auditRepository.insert({ eventType: 'host_deleted', requestId: request.id });
    reply.code(204).send();
  });

  app.post('/api/hosts/:id/test-connection', async (request, reply) => {
    const session = requireUnlockedSession(request, dependencies.sessionStore);
    if (!dependencies.sshSessionManager) {
      throw new AppError('SSH_CONNECTION_FAILED');
    }

    const id = hostId(request.params);
    const row = readHost(dependencies, id);
    let challenge: SshHostKeyChallenge | undefined;
    const result = await dependencies.sshSessionManager.testConnection(
      await toSshConfig(dependencies, session.record.vaultKey, row),
      {
        onHostKey: async (nextChallenge) => {
          challenge = nextChallenge;
          return false;
        }
      }
    );

    if (challenge || result.hostKey) {
      reply.code(409).send({ ok: false, hostKey: challenge ?? result.hostKey });
      return;
    }

    if (result.ok) {
      reply.send({ ok: true });
      return;
    }

    throw new AppError('SSH_CONNECTION_FAILED');
  });
};
