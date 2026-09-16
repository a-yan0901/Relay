import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { ACCOUNT_DELETION_CONFIRMATION } from '../../shared/core/account-sync.js';
import { AccountService, type AccountDeviceInput } from './account-service.js';
import { AccountSessionStore } from './account-session-store.js';
import {
  clearAccountSessionCookie,
  getAccountSessionId,
  setAccountSessionCookie
} from '../auth/account-cookie.js';
import { AuditRepository } from '../db/repositories.js';
import type { SyncCoordinatorPort } from '../sync/sync-service.js';

export interface AccountRouteDependencies {
  accountService: AccountService;
  accountSessionStore: AccountSessionStore;
  auditRepository: AuditRepository;
  enabled: boolean;
  secureCookie: boolean;
  syncCoordinator?: SyncCoordinatorPort;
}

const authBodySchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(4096),
  deviceLabel: z.string().min(1).max(128).optional(),
  platform: z.enum(['web', 'desktop', 'android']).default('web')
}).strict();

const deviceParamsSchema = z.object({
  deviceId: z.string().min(1).max(128)
}).strict();

const reauthBodySchema = z.object({
  password: z.string().min(1).max(4096)
}).strict();

const accountDeletionBodySchema = z.object({
  confirmDelete: z.literal(ACCOUNT_DELETION_CONFIRMATION)
}).strict();

const emptyBodySchema = z.object({}).strict();

const parseAuthBody = (body: unknown): { email: string; password: string; device: AccountDeviceInput } => {
  const parsed = authBodySchema.safeParse(body);
  if (!parsed.success) throw new AppError('PROTOCOL_INVALID_MESSAGE');
  return {
    email: parsed.data.email,
    password: parsed.data.password,
    device: { label: parsed.data.deviceLabel, platform: parsed.data.platform }
  };
};

const requireEnabled = (enabled: boolean): void => {
  if (!enabled) throw new AppError('CAPABILITY_UNAVAILABLE');
};

const parseEmptyBody = (body: unknown): void => {
  const parsed = emptyBodySchema.safeParse(body ?? {});
  if (!parsed.success) throw new AppError('PROTOCOL_INVALID_MESSAGE');
};

export const registerAccountRoutes = async (
  app: FastifyInstance,
  dependencies: AccountRouteDependencies
): Promise<void> => {
  const audit = (eventType: string, requestId: string, accountId?: string, deviceId?: string): void => {
    dependencies.auditRepository.insert({
      eventType,
      requestId,
      metadata: {
        action: eventType,
        ...(accountId === undefined ? {} : { accountId }),
        ...(deviceId === undefined ? {} : { deviceId })
      }
    });
  };

  app.post('/api/account/register', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    dependencies.accountService.purgeExpiredDeletions();
    const input = parseAuthBody(request.body);
    const account = await dependencies.accountService.register(input.email, input.password, input.device);
    const sessionId = dependencies.accountService.issueSessionToken(account);
    setAccountSessionCookie(reply, sessionId, { secure: dependencies.secureCookie });
    audit('account_registered', request.id, account.accountId, account.deviceId);
    reply.code(201).send({ account });
  });

  app.post('/api/account/session', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    dependencies.accountService.purgeExpiredDeletions();
    const input = parseAuthBody(request.body);
    const account = await dependencies.accountService.signIn(input.email, input.password, input.device);
    const sessionId = dependencies.accountService.issueSessionToken(account);
    setAccountSessionCookie(reply, sessionId, { secure: dependencies.secureCookie });
    audit('account_signed_in', request.id, account.accountId, account.deviceId);
    reply.send({ account });
  });

  app.get('/api/account/session', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    dependencies.accountService.purgeExpiredDeletions();
    const sessionId = getAccountSessionId(request);
    reply.send({ account: sessionId ? dependencies.accountService.status(sessionId) : null });
  });

  app.delete('/api/account/session', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    dependencies.accountService.purgeExpiredDeletions();
    const sessionId = getAccountSessionId(request);
    const session = sessionId ? dependencies.accountService.status(sessionId) : null;
    if (sessionId) await dependencies.accountService.signOut(sessionId);
    if (session) dependencies.syncCoordinator?.cancelAccount(session.accountId);
    if (session) audit('account_signed_out', request.id, session.accountId, session.deviceId);
    clearAccountSessionCookie(reply, { secure: dependencies.secureCookie });
    reply.code(204).send();
  });

  app.get('/api/account/devices', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    dependencies.accountService.purgeExpiredDeletions();
    const sessionId = getAccountSessionId(request);
    if (!sessionId) throw new AppError('ACCOUNT_SESSION_INVALID');
    reply.send(await dependencies.accountService.listDevices(sessionId));
  });

  app.delete('/api/account/devices/:deviceId', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    dependencies.accountService.purgeExpiredDeletions();
    const parsed = deviceParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new AppError('ACCOUNT_DEVICE_REVOKED');
    const sessionId = getAccountSessionId(request);
    if (!sessionId) throw new AppError('ACCOUNT_SESSION_INVALID');
    const session = dependencies.accountService.status(sessionId);
    if (!session) throw new AppError('ACCOUNT_SESSION_INVALID');
    await dependencies.accountService.revokeDevice(sessionId, parsed.data.deviceId);
    dependencies.syncCoordinator?.cancelAccount(session.accountId);
    audit('account_device_revoked', request.id, session.accountId, parsed.data.deviceId);
    if (session.deviceId === parsed.data.deviceId) {
      clearAccountSessionCookie(reply, { secure: dependencies.secureCookie });
    }
    reply.code(204).send();
  });

  app.post('/api/account/session/reauth', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const sessionId = getAccountSessionId(request);
    if (!sessionId) throw new AppError('ACCOUNT_SESSION_INVALID');
    const parsed = reauthBodySchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('PROTOCOL_INVALID_MESSAGE');
    await dependencies.accountService.reauthenticate(sessionId, parsed.data.password);
    audit('account_reauthenticated', request.id);
    reply.header('cache-control', 'no-store').code(204).send();
  });

  app.get('/api/account/deletion', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    dependencies.accountService.purgeExpiredDeletions();
    const sessionId = getAccountSessionId(request);
    if (!sessionId) throw new AppError('ACCOUNT_SESSION_INVALID');
    reply.send({ deletion: dependencies.accountService.getDeletion(sessionId) });
  });

  app.post('/api/account/deletion', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    dependencies.accountService.purgeExpiredDeletions();
    const sessionId = getAccountSessionId(request);
    if (!sessionId) throw new AppError('ACCOUNT_SESSION_INVALID');
    const parsed = accountDeletionBodySchema.safeParse(request.body);
    if (!parsed.success) throw new AppError('PROTOCOL_INVALID_MESSAGE');
    const session = dependencies.accountService.assertReauthenticated(sessionId);
    const deletion = dependencies.accountService.requestDeletion(sessionId, parsed.data.confirmDelete);
    dependencies.syncCoordinator?.cancelAccount(session.accountId);
    audit('account_deletion_requested', request.id, session.accountId, session.deviceId);
    clearAccountSessionCookie(reply, { secure: dependencies.secureCookie });
    reply.code(202).send({ deletion });
  });

  app.post('/api/account/deletion/restore', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    dependencies.accountService.purgeExpiredDeletions();
    const sessionId = getAccountSessionId(request);
    if (!sessionId) throw new AppError('ACCOUNT_SESSION_INVALID');
    parseEmptyBody(request.body);
    const session = dependencies.accountService.assertReauthenticated(sessionId);
    dependencies.accountService.restoreDeletion(sessionId);
    audit('account_deletion_restored', request.id, session.accountId, session.deviceId);
    reply.header('cache-control', 'no-store').code(204).send();
  });
};
