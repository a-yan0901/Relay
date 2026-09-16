import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/server/app.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';

const MASTER_PASSWORD = 'correct horse battery staple';
const databases: ReturnType<typeof openDatabase>[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

const setup = async () => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
  const app = await buildApp({ database, config: { nodeEnv: 'test', port: 3000, dataDir: ':memory:', trustedOrigins: ['http://localhost:4173'], sessionIdleTimeoutMs: 60_000, maxSessions: 4, logLevel: 'silent' } });
  apps.push(app);
  const response = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
  const header = response.headers['set-cookie'];
  const cookie = (Array.isArray(header) ? header[0] : header)?.split(';', 1)[0];
  if (!cookie) throw new Error('session cookie missing');
  return { app, cookie };
};

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const database of databases.splice(0)) database.close();
});

describe('audit routes', () => {
  it('requires an unlocked session and returns redacted, filterable activity', async () => {
    const { app, cookie } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/audit' })).statusCode).toBe(401);
    const created = await app.inject({
      method: 'POST', url: '/api/hosts', headers: { cookie },
      payload: { name: 'Audit Fixture', address: '10.0.0.8', username: 'deploy', auth: { type: 'password', password: 'host-secret' } }
    });
    expect(created.statusCode).toBe(201);
    const response = await app.inject({ method: 'GET', url: '/api/audit?eventType=host_created&limit=10', headers: { cookie } });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('host_created');
    expect(response.body).not.toContain('host-secret');
    expect(JSON.parse(response.body)).toEqual(expect.objectContaining({ items: expect.any(Array) }));
  });

  it('accepts request, status and time filters and returns a cursor for the next page', async () => {
    const { app, cookie } = await setup();
    const first = await app.inject({
      method: 'POST', url: '/api/hosts', headers: { cookie },
      payload: { name: 'Audit Fixture One', address: '10.0.0.8', username: 'deploy', auth: { type: 'password', password: 'host-secret' } }
    });
    const second = await app.inject({
      method: 'POST', url: '/api/hosts', headers: { cookie },
      payload: { name: 'Audit Fixture Two', address: '10.0.0.9', username: 'deploy', auth: { type: 'password', password: 'host-secret-2' } }
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const requestId = first.headers['x-request-id'];
    expect(typeof requestId).toBe('string');
    const filtered = await app.inject({
      method: 'GET',
      url: `/api/audit?requestId=${encodeURIComponent(String(requestId))}&status=succeeded&from=2026-09-15T00%3A00%3A00.000Z&to=2026-09-17T00%3A00%3A00.000Z`,
      headers: { cookie }
    });
    expect(filtered.statusCode).toBe(200);
    expect(JSON.parse(filtered.body).items).toEqual([expect.objectContaining({ eventType: 'host_created', requestId })]);

    const paged = await app.inject({ method: 'GET', url: '/api/audit?status=succeeded&limit=1', headers: { cookie } });
    expect(paged.statusCode).toBe(200);
    expect(JSON.parse(paged.body)).toEqual(expect.objectContaining({ items: expect.any(Array), nextCursor: expect.any(String) }));
  });
});
