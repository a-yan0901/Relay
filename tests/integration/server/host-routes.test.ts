import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/server/app.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';

const MASTER_PASSWORD = 'correct horse battery staple';
const databases: ReturnType<typeof openDatabase>[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

const makeApp = async () => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
  const app = await buildApp({
    database,
    config: {
      nodeEnv: 'test',
      port: 3000,
      dataDir: ':memory:',
      trustedOrigins: ['http://localhost:4173'],
      sessionIdleTimeoutMs: 60_000,
      maxSessions: 4,
      logLevel: 'silent'
    }
  });
  apps.push(app);
  return app;
};

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

const cookieFrom = (response: { headers: Record<string, string | string[] | undefined> }): string => {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) {
    throw new Error('expected session cookie');
  }
  return value.split(';', 1)[0];
};

const setup = async (app: Awaited<ReturnType<typeof makeApp>>): Promise<string> => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/setup',
    payload: { masterPassword: MASTER_PASSWORD }
  });
  return cookieFrom(response);
};

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('host routes', () => {
  it('creates password and private-key hosts, filters metadata, patches credentials, and deletes hosts', async () => {
    const app = await makeApp();
    const cookie = await setup(app);
    const groupResponse = await app.inject({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie },
      payload: { name: 'Production' }
    });
    const group = json<{ id: string }>(groupResponse);

    const password = 'host-password-fixture';
    const created = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: {
        name: 'Production API',
        address: '10.0.0.8',
        username: 'deploy',
        groupId: group.id,
        tags: ['prod', 'api'],
        isFavorite: true,
        auth: { type: 'password', password }
      }
    });
    expect(created.statusCode).toBe(201);
    const host = json<{ id: string; port: number; authType: string }>(created);
    expect(host.port).toBe(22);
    expect(host.authType).toBe('password');
    expect(created.body).not.toContain(password);
    expect(created.body).not.toContain('credentialCiphertext');

    const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----';
    const keyHost = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: {
        name: 'Staging Shell',
        address: 'server.internal.example',
        port: 2222,
        username: 'ops',
        auth: { type: 'private_key', privateKey, passphrase: 'key-passphrase-fixture' }
      }
    });
    expect(keyHost.statusCode).toBe(201);
    expect(keyHost.body).not.toContain(privateKey);

    const filtered = await app.inject({
      method: 'GET',
      url: `/api/hosts?query=production&groupId=${encodeURIComponent(group.id)}&favorite=true`,
      headers: { cookie }
    });
    expect(json<Array<{ id: string }>>(filtered)).toEqual([expect.objectContaining({ id: host.id })]);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/hosts/${host.id}`,
      headers: { cookie },
      payload: {
        name: 'Production Shell',
        auth: { type: 'private_key', privateKey, passphrase: 'key-passphrase-fixture' },
        isFavorite: false
      }
    });
    expect(patched.statusCode).toBe(200);
    expect(json<{ name: string; authType: string; isFavorite: boolean }>(patched)).toEqual(expect.objectContaining({
      name: 'Production Shell',
      authType: 'private_key',
      isFavorite: false
    }));
    expect(patched.body).not.toContain(privateKey);

    const detail = await app.inject({ method: 'GET', url: `/api/hosts/${host.id}`, headers: { cookie } });
    expect(detail.statusCode).toBe(200);
    expect(detail.body).not.toContain(password);
    expect(detail.body).not.toContain(privateKey);
    expect(detail.body).not.toContain('credentialCiphertext');

    const deleted = await app.inject({ method: 'DELETE', url: `/api/hosts/${host.id}`, headers: { cookie } });
    expect(deleted.statusCode).toBe(204);
    const missing = await app.inject({ method: 'GET', url: `/api/hosts/${host.id}`, headers: { cookie } });
    expect(missing.statusCode).toBe(404);
  });

  it('rejects unauthenticated and unsafe host requests', async () => {
    const app = await makeApp();
    const unauthenticated = await app.inject({ method: 'GET', url: '/api/hosts' });
    expect(unauthenticated.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(unauthenticated).error.code).toBe('SESSION_INVALID');

    const cookie = await setup(app);
    const invalid = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: {
        name: 'Unsafe',
        address: 'https://10.0.0.8; reboot',
        username: 'deploy',
        auth: { type: 'password', password: 'fixture-password' },
        command: 'id'
      }
    });
    expect(invalid.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(invalid).error.code).toBe('HOST_VALIDATION_FAILED');
  });
});
