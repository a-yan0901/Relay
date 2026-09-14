import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/server/app.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate as applyMigrations } from '../../../src/server/db/migrations.js';

const MASTER_PASSWORD = 'correct horse battery staple';
const databases: ReturnType<typeof openDatabase>[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

const makeApp = async () => {
  const database = openDatabase(':memory:');
  applyMigrations(database);
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

afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.close();
  }
  for (const database of databases.splice(0)) {
    database.close();
  }
});

describe('setup and unlock routes', () => {
  it('reports setup state, rejects weak passwords, and allows setup once', async () => {
    const app = await makeApp();

    const initial = await app.inject({ method: 'GET', url: '/api/setup/status' });
    expect(initial.statusCode).toBe(200);
    expect(json(initial)).toEqual({ initialized: false, locked: true });

    const weak = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { masterPassword: '1234567' }
    });
    expect(weak.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(weak).error.code).toBe('MASTER_PASSWORD_INVALID');

    const created = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { masterPassword: MASTER_PASSWORD }
    });
    expect(created.statusCode).toBe(201);
    expect(json(created)).toEqual({ initialized: true, locked: false });
    expect(created.body).not.toContain(MASTER_PASSWORD);
    const cookie = cookieFrom(created);
    expect(created.headers['set-cookie']).toMatch(/HttpOnly/iu);
    expect(created.headers['set-cookie']).toMatch(/SameSite=Strict/iu);
    expect(created.headers['set-cookie']).not.toMatch(/Secure/iu);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { masterPassword: MASTER_PASSWORD }
    });
    expect(duplicate.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(duplicate).error.code).toBe('SETUP_ALREADY_COMPLETE');

    const session = await app.inject({
      method: 'GET',
      url: '/api/session',
      headers: { cookie }
    });
    expect(json(session)).toEqual(expect.objectContaining({ initialized: true, locked: false }));
  });

  it('rejects wrong unlock credentials and exposes no vault material', async () => {
    const app = await makeApp();
    await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    await app.inject({ method: 'POST', url: '/api/session/lock' });

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/session/unlock',
      payload: { masterPassword: 'wrong horse battery staple' }
    });
    expect(wrong.statusCode).toBe(401);
    expect(json<{ error: { code: string; message: string } }>(wrong).error.code).toBe('VAULT_UNLOCK_FAILED');
    expect(wrong.body).not.toContain('salt');
    expect(wrong.body).not.toContain('wrappedVaultKey');
  });

  it('locks and revokes the HttpOnly session cookie', async () => {
    const app = await makeApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const cookie = cookieFrom(setup);

    const locked = await app.inject({
      method: 'POST',
      url: '/api/session/lock',
      headers: { cookie }
    });
    expect(locked.statusCode).toBe(204);
    expect(locked.headers['set-cookie']).toMatch(/Max-Age=0/iu);

    const status = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie } });
    expect(json(status)).toEqual({ initialized: true, locked: true });

    const reused = await app.inject({ method: 'POST', url: '/api/session/lock', headers: { cookie } });
    expect(reused.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(reused).error.code).toBe('SESSION_INVALID');
  });
});
