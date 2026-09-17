import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { AccountSession } from '../../shared/core/models.js';
import type { CloudApiClient, CloudAuthResponse, CloudWorkspaceDescriptor } from '../../shared/cloud/client.js';
import { AppError } from '../../shared/errors.js';
import { CloudBrowserSessionStore } from './cloud-session-store.js';

export const CLOUD_ACCOUNT_SESSION_COOKIE_NAME = 'relay_cloud_session';

export interface CloudAccountRouteClient extends Pick<CloudApiClient, 'register' | 'signIn' | 'getSession' | 'refresh' | 'signOut' | 'listDevices' | 'revokeDevice' | 'trustDevice' | 'listWorkspaces' | 'getWorkspace'> {}

export interface CloudAccountRouteDependencies {
  enabled: boolean;
  client: CloudAccountRouteClient;
  sessions: CloudBrowserSessionStore;
  secureCookie: boolean;
}

const authBodySchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(4096),
  deviceLabel: z.string().min(1).max(128).optional()
}).strict();

const deviceParamsSchema = z.object({ deviceId: z.string().min(1).max(128) }).strict();
const workspaceParamsSchema = z.object({ workspaceId: z.string().min(1).max(128) }).strict();
const emptyBodySchema = z.object({}).strict();

const cookieConfig = (secure: boolean) => ({
  path: '/',
  httpOnly: true,
  sameSite: 'strict' as const,
  secure
});

const setCloudCookie = (reply: FastifyReply, id: string, secure: boolean): void => {
  reply.setCookie(CLOUD_ACCOUNT_SESSION_COOKIE_NAME, id, cookieConfig(secure));
};

const clearCloudCookie = (reply: FastifyReply, secure: boolean): void => {
  reply.clearCookie(CLOUD_ACCOUNT_SESSION_COOKIE_NAME, cookieConfig(secure));
};

const cookieId = (request: FastifyRequest): string | null => {
  const value = request.cookies[CLOUD_ACCOUNT_SESSION_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const requireEnabled = (enabled: boolean): void => {
  if (!enabled) throw new AppError('CAPABILITY_UNAVAILABLE');
};

const requireEmptyBody = (body: unknown): void => {
  if (!emptyBodySchema.safeParse(body ?? {}).success) throw new AppError('PROTOCOL_INVALID_MESSAGE');
};

const requireWorkspaceId = (request: FastifyRequest): string => {
  const parsed = workspaceParamsSchema.safeParse(request.params);
  if (!parsed.success) throw new AppError('SYNC_PAYLOAD_INVALID');
  return parsed.data.workspaceId;
};

const requireDeviceId = (request: FastifyRequest): string => {
  const parsed = deviceParamsSchema.safeParse(request.params);
  if (!parsed.success) throw new AppError('ACCOUNT_DEVICE_REVOKED');
  return parsed.data.deviceId;
};

const authInput = (body: unknown): { email: string; password: string; deviceLabel?: string } => {
  const parsed = authBodySchema.safeParse(body);
  if (!parsed.success) throw new AppError('PROTOCOL_INVALID_MESSAGE');
  return parsed.data;
};

const authResponse = (result: CloudAuthResponse): { account: AccountSession } => ({ account: result.account });

interface ActiveCloudSession {
  id: string;
  token: string;
  account: AccountSession;
}

const requireSession = (request: FastifyRequest, sessions: CloudBrowserSessionStore): ActiveCloudSession => {
  const id = cookieId(request);
  if (!id) throw new AppError('ACCOUNT_SESSION_INVALID');
  const session = sessions.get(id);
  if (!session) throw new AppError('ACCOUNT_SESSION_INVALID');
  return { id, token: session.token, account: session.account };
};

const isInvalidSession = (error: unknown): boolean => error instanceof AppError && error.code === 'ACCOUNT_SESSION_INVALID';

/**
 * Web-only BFF routes for the standalone cloud service. The browser receives
 * account metadata and a cookie reference, never the cloud bearer token.
 */
export const registerCloudAccountRoutes = async (
  app: FastifyInstance,
  dependencies: CloudAccountRouteDependencies
): Promise<void> => {
  app.post('/api/cloud/account/register', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const input = authInput(request.body);
    const result = await dependencies.client.register(input.email, input.password, {
      platform: 'web',
      ...(input.deviceLabel === undefined ? {} : { label: input.deviceLabel })
    });
    const oldId = cookieId(request);
    if (oldId) dependencies.sessions.revoke(oldId);
    setCloudCookie(reply, dependencies.sessions.create(result.token, result.account), dependencies.secureCookie);
    reply.header('cache-control', 'no-store').code(201).send(authResponse(result));
  });

  app.post('/api/cloud/account/session', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const input = authInput(request.body);
    const result = await dependencies.client.signIn(input.email, input.password, {
      platform: 'web',
      ...(input.deviceLabel === undefined ? {} : { label: input.deviceLabel })
    });
    const oldId = cookieId(request);
    if (oldId) dependencies.sessions.revoke(oldId);
    setCloudCookie(reply, dependencies.sessions.create(result.token, result.account), dependencies.secureCookie);
    reply.header('cache-control', 'no-store').send(authResponse(result));
  });

  app.get('/api/cloud/account/session', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const id = cookieId(request);
    if (!id) {
      reply.header('cache-control', 'no-store').send({ account: null });
      return;
    }
    const stored = dependencies.sessions.get(id);
    if (!stored) {
      clearCloudCookie(reply, dependencies.secureCookie);
      reply.header('cache-control', 'no-store').send({ account: null });
      return;
    }
    try {
      const current = await dependencies.client.getSession(stored.token);
      dependencies.sessions.replace(id, stored.token, current.account);
      reply.header('cache-control', 'no-store').send(current);
    } catch (error) {
      if (!isInvalidSession(error)) throw error;
      dependencies.sessions.revoke(id);
      clearCloudCookie(reply, dependencies.secureCookie);
      reply.header('cache-control', 'no-store').send({ account: null });
    }
  });

  app.post('/api/cloud/account/refresh', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    requireEmptyBody(request.body);
    const active = requireSession(request, dependencies.sessions);
    const result = await dependencies.client.refresh(active.token);
    dependencies.sessions.replace(active.id, result.token, result.account);
    reply.header('cache-control', 'no-store').send(authResponse(result));
  });

  app.delete('/api/cloud/account/session', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const id = cookieId(request);
    if (id) {
      const stored = dependencies.sessions.get(id);
      dependencies.sessions.revoke(id);
      if (stored) await dependencies.client.signOut(stored.token).catch(() => undefined);
    }
    clearCloudCookie(reply, dependencies.secureCookie);
    reply.code(204).send();
  });

  app.get('/api/cloud/devices', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const active = requireSession(request, dependencies.sessions);
    reply.send(await dependencies.client.listDevices(active.token));
  });

  app.delete('/api/cloud/devices/:deviceId', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const active = requireSession(request, dependencies.sessions);
    const deviceId = requireDeviceId(request);
    await dependencies.client.revokeDevice(active.token, deviceId);
    if (deviceId === active.account.deviceId) {
      dependencies.sessions.revoke(active.id);
      clearCloudCookie(reply, dependencies.secureCookie);
    }
    reply.code(204).send();
  });

  app.post('/api/cloud/devices/:deviceId/trust', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    requireEmptyBody(request.body);
    const active = requireSession(request, dependencies.sessions);
    await dependencies.client.trustDevice(active.token, requireDeviceId(request));
    reply.code(204).send();
  });

  app.get('/api/cloud/workspaces', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const active = requireSession(request, dependencies.sessions);
    const workspaces: readonly CloudWorkspaceDescriptor[] = await dependencies.client.listWorkspaces(active.token);
    reply.send(workspaces);
  });

  app.get('/api/cloud/workspaces/:workspaceId/descriptor', async (request, reply) => {
    requireEnabled(dependencies.enabled);
    const active = requireSession(request, dependencies.sessions);
    reply.send(await dependencies.client.getWorkspace(active.token, requireWorkspaceId(request)));
  });
};
