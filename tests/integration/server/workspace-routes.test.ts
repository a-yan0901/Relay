import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../../src/server/app.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';

const MASTER_PASSWORD = 'correct horse battery staple';
const EXPORT_PASSWORD = 'bundle-export-password';
const databases: ReturnType<typeof openDatabase>[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

const makeApp = async () => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
  const app = await buildApp({ database, config: {
    nodeEnv: 'test', port: 3000, dataDir: ':memory:', trustedOrigins: ['http://localhost:4173'],
    sessionIdleTimeoutMs: 60_000, maxSessions: 4, logLevel: 'silent'
  } });
  apps.push(app);
  return app;
};

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;
const cookieFrom = (response: { headers: Record<string, string | string[] | undefined> }): string => {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('expected session cookie');
  return value.split(';', 1)[0];
};
const setup = async (app: Awaited<ReturnType<typeof makeApp>>): Promise<string> => {
  const response = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
  return cookieFrom(response);
};

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const database of databases.splice(0)) database.close();
});

describe('workspace and vault routes', () => {
  it('persists workspace intent with optimistic version conflicts', async () => {
    const app = await makeApp();
    const cookie = await setup(app);
    const initial = await app.inject({ method: 'GET', url: '/api/workspace', headers: { cookie } });
    expect(initial.statusCode).toBe(200);
    expect(json<{ version: number }>(initial).version).toBe(0);
    const state = { version: 0, tabs: [], activeTabId: null, layout: { mode: 'single', ratio: 0.5 }, filters: { query: '', groupId: null, favoriteOnly: false } };
    const saved = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { cookie }, payload: { expectedVersion: 0, state } });
    expect(saved.statusCode).toBe(200);
    expect(json<{ version: number }>(saved).version).toBe(1);
    const stale = await app.inject({ method: 'PUT', url: '/api/workspace', headers: { cookie }, payload: { expectedVersion: 0, state } });
    expect(stale.statusCode).toBe(409);
    expect(json<{ error: { code: string } }>(stale).error.code).toBe('WORKSPACE_VERSION_CONFLICT');
  });

  it('exports and previews encrypted host data without returning credentials', async () => {
    const app = await makeApp();
    const cookie = await setup(app);
    const password = 'host-password-not-returned';
    const created = await app.inject({ method: 'POST', url: '/api/hosts', headers: { cookie }, payload: {
      name: 'Production', address: '10.0.0.8', username: 'ops', auth: { type: 'password', password }
    } });
    expect(created.statusCode).toBe(201);
    const exported = await app.inject({ method: 'POST', url: '/api/vault/export', headers: { cookie }, payload: { exportPassword: EXPORT_PASSWORD } });
    expect(exported.statusCode).toBe(200);
    expect(exported.body).not.toContain(password);
    const bundle = json<{ bundle: string }>(exported).bundle;
    const preview = await app.inject({ method: 'POST', url: '/api/vault/import/preview', headers: { cookie }, payload: { exportPassword: EXPORT_PASSWORD, bundle } });
    expect(preview.statusCode).toBe(200);
    expect(json<{ hostCount: number }>(preview).hostCount).toBe(1);
  });
});
