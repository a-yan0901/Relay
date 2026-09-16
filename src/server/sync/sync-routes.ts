import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { AccountSession, SyncEnvelope } from '../../shared/core/models.js';
import { AppError } from '../../shared/errors.js';
import { CLOUD_SYNC_DELETION_CONFIRMATION } from '../../shared/core/account-sync.js';
import { getAccountSessionId } from '../auth/account-cookie.js';
import { AppConfigRepository, AuditRepository } from '../db/repositories.js';
import { AccountService } from '../account/account-service.js';
import { SessionStore } from '../auth/session-store.js';
import { requireUnlockedSession } from '../api/route-helpers.js';
import type { SyncCoordinatorPort, SyncServiceContract } from './sync-service.js';

export interface SyncRouteDependencies {
  enabled: boolean;
  ownerId: string;
  accountService: AccountService;
  appConfigRepository: AppConfigRepository;
  sessionStore: SessionStore;
  syncService: SyncServiceContract;
  syncCoordinator: SyncCoordinatorPort;
  auditRepository: AuditRepository;
}

const MAX_SYNC_BYTES = 32 * 1024 * 1024;
const envelopeSchema = z.object({
  schemaVersion: z.literal(1),
  vaultId: z.string().min(1).max(128),
  revision: z.number().int().min(1).max(1_000_000_000),
  parentRevision: z.number().int().min(0).max(1_000_000_000).nullable(),
  deviceId: z.string().min(1).max(128),
  keyVersion: z.number().int().min(1).max(32),
  nonce: z.string().min(1).max(256),
  ciphertext: z.string().max(64 * 1024 * 1024),
  authTag: z.string().min(1).max(256),
  aad: z.string().min(1).max(1024),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/iu),
  byteLength: z.number().int().min(0).max(MAX_SYNC_BYTES)
}).strict();

const conflictParamsSchema = z.object({ conflictId: z.string().min(1).max(128) }).strict();
const resolveBodySchema = z.object({ resolution: z.enum(['keep-local', 'use-remote', 'export-both']) }).strict();
const exportBodySchema = z.object({ exportPassword: z.string().min(8).max(4_096) }).strict();
const recoveryKeyBodySchema = z.object({ recoveryKey: z.string().min(1).max(128) }).strict();
const deleteBodySchema = z.object({
  confirmDelete: z.literal(CLOUD_SYNC_DELETION_CONFIRMATION)
}).strict();
const emptyBodySchema = z.object({}).strict();

const requireEnabled = (dependencies: SyncRouteDependencies): void => {
  if (!dependencies.enabled) throw new AppError('CAPABILITY_UNAVAILABLE');
};

const requireAccount = (request: FastifyRequest, dependencies: SyncRouteDependencies): AccountSession => {
  const sessionId = getAccountSessionId(request);
  const session = sessionId ? dependencies.accountService.status(sessionId) : null;
  if (!session) throw new AppError('ACCOUNT_SESSION_INVALID');
  return session;
};

const requireSyncAccount = (request: FastifyRequest, dependencies: SyncRouteDependencies): AccountSession => {
  const account = requireAccount(request, dependencies);
  if (dependencies.accountService.isDeletionPending(account.accountId)) {
    throw new AppError('ACCOUNT_DELETION_PENDING');
  }
  if (dependencies.syncService.getDeleteRequest(account.accountId) !== null) {
    throw new AppError('SYNC_DELETE_PENDING');
  }
  return account;
};

const parseEnvelope = (body: unknown): SyncEnvelope => {
  const parsed = envelopeSchema.safeParse(body);
  if (!parsed.success) throw new AppError('SYNC_PAYLOAD_INVALID');
  return parsed.data;
};

const idempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers['idempotency-key'];
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate !== 'string' || candidate.length === 0 || candidate.length > 256) {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
  return candidate;
};

const audit = (dependencies: SyncRouteDependencies, eventType: string, requestId: string, session: AccountSession, extra: Record<string, unknown> = {}): void => {
  dependencies.auditRepository.insert({
    eventType,
    requestId,
    metadata: { accountId: session.accountId, deviceId: session.deviceId, action: eventType, ...extra }
  });
};

export const registerSyncRoutes = async (app: FastifyInstance, dependencies: SyncRouteDependencies): Promise<void> => {
  app.get('/api/sync/v1/state', async (request, reply) => {
    requireEnabled(dependencies);
    const session = requireAccount(request, dependencies);
    if (dependencies.accountService.isDeletionPending(session.accountId)) {
      reply.send({ sync: 'local-only', head: null, pendingCount: 0, lastErrorCode: 'ACCOUNT_DELETION_PENDING' });
      return;
    }
    reply.send(dependencies.syncService.status(session.accountId));
  });

  app.get('/api/sync/v1/descriptor', async (request, reply) => {
    requireEnabled(dependencies);
    const session = requireSyncAccount(request, dependencies);
    reply.send({ descriptor: dependencies.syncService.getDescriptor(session.accountId) });
  });

  app.post('/api/sync/v1/enable', async (request, reply) => {
    requireEnabled(dependencies);
    const account = requireSyncAccount(request, dependencies);
    const vaultSession = requireUnlockedSession(request, dependencies.sessionStore);
    const appConfig = dependencies.appConfigRepository.get();
    if (!appConfig) throw new AppError('VAULT_NOT_INITIALIZED');
    const head = await dependencies.syncService.enable(
      account.accountId,
      dependencies.ownerId,
      account.deviceId,
      vaultSession.record.vaultKey,
      appConfig.vaultConfig
    );
    audit(dependencies, 'sync_enabled', request.id, account, { vaultId: head.vaultId, revision: head.revision });
    reply.code(201).send(head);
  });

  app.post('/api/sync/v1/recovery-key/issue', async (request, reply) => {
    requireEnabled(dependencies);
    const account = requireSyncAccount(request, dependencies);
    const vaultSession = requireUnlockedSession(request, dependencies.sessionStore);
    const issued = dependencies.syncService.issueRecoveryKey(account.accountId, vaultSession.record.vaultKey);
    const recovery = dependencies.syncService.getRecoveryKeyState(account.accountId);
    audit(dependencies, 'sync_recovery_key_issued', request.id, account, { keyVersion: issued.keyVersion });
    reply.header('cache-control', 'no-store').code(201).send({ ...issued, recovery });
  });

  app.post('/api/sync/v1/recovery-key/confirm', async (request, reply) => {
    requireEnabled(dependencies);
    const account = requireSyncAccount(request, dependencies);
    const vaultSession = requireUnlockedSession(request, dependencies.sessionStore);
    const parsed = recoveryKeyBodySchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('SYNC_PAYLOAD_INVALID');
    const state = dependencies.syncService.confirmRecoveryKey(
      account.accountId,
      vaultSession.record.vaultKey,
      parsed.data.recoveryKey
    );
    audit(dependencies, 'sync_recovery_key_confirmed', request.id, account, {
      keyVersion: state.activeKeyVersion,
      status: state.status
    });
    reply.header('cache-control', 'no-store').send(state);
  });

  app.get('/api/sync/v1/envelope', async (request, reply) => {
    requireEnabled(dependencies);
    const session = requireSyncAccount(request, dependencies);
    reply.send({ envelope: dependencies.syncService.pull(session.accountId) });
  });

  app.put('/api/sync/v1/envelope', async (request, reply) => {
    requireEnabled(dependencies);
    const session = requireSyncAccount(request, dependencies);
    const envelope = parseEnvelope(request.body);
    if (envelope.deviceId !== session.deviceId) throw new AppError('ACCOUNT_DEVICE_REVOKED');
    const head = dependencies.syncService.push(session.accountId, envelope, idempotencyKey(request));
    audit(dependencies, 'sync_envelope_pushed', request.id, session, { vaultId: head.vaultId, revision: head.revision });
    reply.send(head);
  });

  app.post('/api/sync/v1/pull/preview', async (request, reply) => {
    requireEnabled(dependencies);
    const account = requireSyncAccount(request, dependencies);
    const vaultSession = requireUnlockedSession(request, dependencies.sessionStore);
    const preview = await dependencies.syncService.previewPull(account.accountId, dependencies.ownerId, vaultSession.record.vaultKey);
    reply.send(preview);
  });

  app.post('/api/sync/v1/conflicts/:conflictId/export', async (request, reply) => {
    requireEnabled(dependencies);
    const account = requireSyncAccount(request, dependencies);
    const vaultSession = requireUnlockedSession(request, dependencies.sessionStore);
    const params = conflictParamsSchema.safeParse(request.params);
    const body = exportBodySchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError('SYNC_PAYLOAD_INVALID');
    const exported = await dependencies.syncService.exportConflict(
      account.accountId,
      dependencies.ownerId,
      vaultSession.record.vaultKey,
      params.data.conflictId,
      body.data.exportPassword
    );
    audit(dependencies, 'sync_conflict_exported', request.id, account, {
      conflictId: exported.conflictId,
      localRevision: exported.copies[0].revision,
      remoteRevision: exported.copies[1].revision,
      status: 'succeeded'
    });
    reply.type('application/json').header('cache-control', 'no-store').send(exported);
  });

  app.post('/api/sync/v1/conflicts/:conflictId/resolve', async (request, reply) => {
    requireEnabled(dependencies);
    const account = requireSyncAccount(request, dependencies);
    const vaultSession = requireUnlockedSession(request, dependencies.sessionStore);
    const params = conflictParamsSchema.safeParse(request.params);
    const body = resolveBodySchema.safeParse(request.body);
    if (!params.success || !body.success) throw new AppError('SYNC_PAYLOAD_INVALID');
    await dependencies.syncService.resolveConflict(
      account.accountId,
      dependencies.ownerId,
      vaultSession.record.vaultKey,
      params.data.conflictId,
      body.data.resolution
    );
    audit(dependencies, 'sync_conflict_resolved', request.id, account, { resolution: body.data.resolution });
    reply.code(204).send();
  });

  app.post('/api/sync/v1/retry', async (request, reply) => {
    requireEnabled(dependencies);
    const account = requireSyncAccount(request, dependencies);
    await dependencies.syncCoordinator.retry(account.accountId);
    reply.code(202).send(dependencies.syncService.status(account.accountId));
  });

  app.post('/api/sync/v1/vault/delete', async (request, reply) => {
    requireEnabled(dependencies);
    const body = deleteBodySchema.safeParse(request.body);
    if (!body.success) throw new AppError('SYNC_DELETE_CONFIRMATION_REQUIRED');
    const sessionId = getAccountSessionId(request);
    if (!sessionId) throw new AppError('ACCOUNT_SESSION_INVALID');
    const account = requireSyncAccount(request, dependencies);
    dependencies.accountService.assertReauthenticated(sessionId);
    dependencies.syncService.requestDeletion(account.accountId);
    dependencies.accountService.clearReauthentication(sessionId);
    dependencies.syncCoordinator.cancelAccount(account.accountId);
    const deletion = dependencies.syncService.status(account.accountId).deletion;
    if (!deletion) throw new AppError('INTERNAL_ERROR');
    audit(dependencies, 'sync_vault_delete_requested', request.id, account, { status: 'queued' });
    reply.code(202).send(deletion);
  });

  app.post('/api/sync/v1/vault/restore', async (request, reply) => {
    requireEnabled(dependencies);
    const account = requireAccount(request, dependencies);
    if (dependencies.accountService.isDeletionPending(account.accountId)) {
      throw new AppError('ACCOUNT_DELETION_PENDING');
    }
    if (!emptyBodySchema.safeParse(request.body ?? {}).success) throw new AppError('SYNC_PAYLOAD_INVALID');
    const sessionId = getAccountSessionId(request);
    if (!sessionId) throw new AppError('ACCOUNT_SESSION_INVALID');
    dependencies.accountService.assertReauthenticated(sessionId);
    dependencies.syncService.restoreDeletion(account.accountId);
    dependencies.accountService.clearReauthentication(sessionId);
    audit(dependencies, 'sync_vault_delete_restored', request.id, account, { status: 'succeeded' });
    reply.code(204).send();
  });
};
