import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { AccountService, type AccountDeviceInput } from './account-service.js';
import { AccountSessionStore } from './account-session-store.js';
import {
  clearAccountSessionCookie,
  getAccountSessionId,
  setAccountSessionCookie
} from '../auth/account-cookie.js';
import { AuditRepository } from '../db/repositories.js';

export interface AccountRouteDependencies {
  accountService: AccountService;
  accountSessionStore: AccountSessionStore;
  auditRepository: AuditRepository;
  enabled: boolean;
  secureCookie: boolean;
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
    const input = parseAuthBody(request.body);
    const account = await dependencies.accountService.register(input.email, input.password, input.device);
    const sessionId = dependencies.accountService.issueSessionToken(account);
    setAccountSessionCookie(reply, sessionId, { secure: dependencies.secureCookie });
    audit('account_registered', request.id, account.accountId, account.deviceId);
    reply.code(201).send({ account });
  });

  app.post('/api/account/session', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const input = parseAuthBody(request.body);
    const account = await dependencies.accountService.signIn(input.email, input.password, input.device);
    const sessionId = dependencies.accountService.issueSessionToken(account);
    setAccountSessionCookie(reply, sessionId, { secure: dependencies.secureCookie });
    audit('account_signed_in', request.id, account.accountId, account.deviceId);
    reply.send({ account });
  });

  app.get('/api/account/session', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const sessionId = getAccountSessionId(request);
    reply.send({ account: sessionId ? dependencies.accountService.status(sessionId) : null });
  });

  app.delete('/api/account/session', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const sessionId = getAccountSessionId(request);
    const session = sessionId ? dependencies.accountService.status(sessionId) : null;
    if (sessionId) await dependencies.accountService.signOut(sessionId);
    if (session) audit('account_signed_out', request.id, session.accountId, session.deviceId);
    clearAccountSessionCookie(reply, { secure: dependencies.secureCookie });
    reply.code(204).send();
  });

  app.get('/api/account/devices', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const sessionId = getAccountSessionId(request);
    if (!sessionId) throw new AppError('ACCOUNT_SESSION_INVALID');
    reply.send(await dependencies.accountService.listDevices(sessionId));
  });

  app.delete('/api/account/devices/:deviceId', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const parsed = deviceParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new AppError('ACCOUNT_DEVICE_REVOKED');
    const sessionId = getAccountSessionId(request);
    if (!sessionId) throw new AppError('ACCOUNT_SESSION_INVALID');
    const session = dependencies.accountService.status(sessionId);
    if (!session) throw new AppError('ACCOUNT_SESSION_INVALID');
    await dependencies.accountService.revokeDevice(sessionId, parsed.data.deviceId);
    audit('account_device_revoked', request.id, session.accountId, parsed.data.deviceId);
    if (session.deviceId === parsed.data.deviceId) {
      clearAccountSessionCookie(reply, { secure: dependencies.secureCookie });
    }
    reply.code(204).send();
  });
};
