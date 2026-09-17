import cookie from '@fastify/cookie';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import { CloudBrowserSessionStore } from '../../../src/server/cloud/cloud-session-store.js';
import { registerCloudAccountRoutes } from '../../../src/server/cloud/cloud-account-routes.js';

const account = {
  accountId: 'account-1',
  deviceId: 'device-1',
  state: 'signed-in' as const,
  expiresAt: '2026-10-18T00:00:00.000Z',
  trusted: true
};

const makeClient = () => ({
  lastDevice: undefined as { publicKey?: string | null } | undefined,
  async register(_email: string, _password: string, device: { publicKey?: string | null }) { this.lastDevice = device; return { account, token: 'a'.repeat(43) }; },
  async signIn(_email: string, _password: string, device: { publicKey?: string | null }) { this.lastDevice = device; return { account, token: 'b'.repeat(43) }; },
  async getSession() { return { account }; },
  async refresh() { return { account, token: 'c'.repeat(43) }; },
  async signOut() {},
  async listDevices() { return [{ id: 'device-1', label: 'Browser', platform: 'web' as const, lastSeenAt: null, current: true, revokedAt: null, trustedAt: '2026-09-18T00:00:00.000Z' }]; },
  async revokeDevice() {},
  async trustDevice() {},
  async listWorkspaces() { return [{ id: 'workspace-1', accountId: account.accountId, ownerDeviceId: account.deviceId, encryptedTitle: 'v1:', createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z', deletedAt: null, online: true, activeViewerCount: 0 }]; },
  async getWorkspace() { return this.listWorkspaces().then((workspaces) => workspaces[0]); }
});

const cookieValue = (response: { headers: Record<string, string | string[] | undefined> }): string => {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const value = values.find((item) => item.startsWith('relay_cloud_session='));
  if (!value) throw new Error('cloud cookie missing');
  return value.split(';', 1)[0];
};

describe('web cloud account BFF routes', () => {
  it('keeps bearer tokens out of browser responses and exposes the directory through an HttpOnly session', async () => {
    const app = Fastify({ logger: false });
    await app.register(cookie);
    const client = makeClient();
    await registerCloudAccountRoutes(app, {
      enabled: true,
      client,
      sessions: new CloudBrowserSessionStore(),
      secureCookie: false,
      createDeviceKeyPair: async () => ({ publicKey: 'public-key', privateKey: 'private-key' })
    });

    const registered = await app.inject({
      method: 'POST',
      url: '/api/cloud/account/register',
      payload: { email: 'user@example.com', password: 'long enough password', deviceLabel: 'Browser' }
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.body).not.toContain('a'.repeat(43));
    expect(registered.json()).toEqual({ account });
    expect(client.lastDevice).toEqual(expect.objectContaining({ publicKey: 'public-key' }));
    const sessionCookie = cookieValue(registered);
    expect(registered.headers['set-cookie']).toMatch(/HttpOnly/iu);
    expect(registered.headers['set-cookie']).toMatch(/SameSite=Strict/iu);

    const status = await app.inject({ method: 'GET', url: '/api/cloud/account/session', headers: { cookie: sessionCookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ account });

    const devices = await app.inject({ method: 'GET', url: '/api/cloud/devices', headers: { cookie: sessionCookie } });
    expect(devices.statusCode).toBe(200);
    expect(devices.json()[0]).toEqual(expect.objectContaining({ id: 'device-1' }));

    const workspaces = await app.inject({ method: 'GET', url: '/api/cloud/workspaces', headers: { cookie: sessionCookie } });
    expect(workspaces.statusCode).toBe(200);
    expect(workspaces.json()[0]).toEqual(expect.objectContaining({ id: 'workspace-1', online: true }));
  });

  it('rotates the server-side token and revokes the browser session on logout', async () => {
    const app = Fastify({ logger: false });
    await app.register(cookie);
    const client = makeClient();
    const sessions = new CloudBrowserSessionStore();
    await registerCloudAccountRoutes(app, { enabled: true, client, sessions, secureCookie: false });

    const signedIn = await app.inject({ method: 'POST', url: '/api/cloud/account/session', payload: { email: 'user@example.com', password: 'long enough password' } });
    const sessionCookie = cookieValue(signedIn);
    const refreshed = await app.inject({ method: 'POST', url: '/api/cloud/account/refresh', headers: { cookie: sessionCookie } });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.body).not.toContain('c'.repeat(43));
    expect(refreshed.json()).toEqual({ account });

    const loggedOut = await app.inject({ method: 'DELETE', url: '/api/cloud/account/session', headers: { cookie: sessionCookie } });
    expect(loggedOut.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/cloud/devices', headers: { cookie: sessionCookie } })).statusCode).toBe(401);
  });

  it('returns a stable auth error when a route has no cloud session', async () => {
    const app = Fastify({ logger: false });
    await app.register(cookie);
    await registerCloudAccountRoutes(app, {
      enabled: true,
      client: makeClient(),
      sessions: new CloudBrowserSessionStore(),
      secureCookie: false
    });

    await expect(app.inject({ method: 'GET', url: '/api/cloud/devices' })).resolves.toMatchObject({ statusCode: 401 });
  });

  it('does not register cloud routes when the cloud endpoint is not configured', async () => {
    const app = Fastify({ logger: false });
    await app.register(cookie);
    app.setErrorHandler((error, _request, reply) => {
      const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      reply.status(error instanceof AppError ? error.statusCode : 500).send({ error: { code } });
    });
    await registerCloudAccountRoutes(app, {
      enabled: false,
      client: makeClient(),
      sessions: new CloudBrowserSessionStore(),
      secureCookie: false
    });

    const response = await app.inject({ method: 'POST', url: '/api/cloud/account/register', payload: { email: 'user@example.com', password: 'long enough password' } });
    expect(response.statusCode).toBe(501);
    expect(response.json().error.code).toBe('CAPABILITY_UNAVAILABLE');
  });

  it('clears a browser session after the cloud token is rejected', async () => {
    const app = Fastify({ logger: false });
    await app.register(cookie);
    const client = {
      ...makeClient(),
      async getSession() { throw new AppError('ACCOUNT_SESSION_INVALID'); }
    };
    await registerCloudAccountRoutes(app, { enabled: true, client, sessions: new CloudBrowserSessionStore(), secureCookie: false });

    const signedIn = await app.inject({ method: 'POST', url: '/api/cloud/account/session', payload: { email: 'user@example.com', password: 'long enough password' } });
    const sessionCookie = cookieValue(signedIn);
    const status = await app.inject({ method: 'GET', url: '/api/cloud/account/session', headers: { cookie: sessionCookie } });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toEqual({ account: null });
    expect(status.headers['set-cookie']).toMatch(/relay_cloud_session=/u);
  });
});
