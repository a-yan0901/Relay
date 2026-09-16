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

describe('command routes', () => {
  it('requires an unlocked session and exposes snippet and run route boundaries', async () => {
    const { app, cookie } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/snippets' })).statusCode).toBe(401);

    const created = await app.inject({
      method: 'POST',
      url: '/api/snippets',
      headers: { cookie },
      payload: { name: 'Inspect service', command: 'systemctl status {{service}}', variables: ['service'], tags: ['ops'] }
    });
    expect(created.statusCode).toBe(201);
    expect(created.body).not.toContain('credential');

    const listed = await app.inject({ method: 'GET', url: '/api/snippets', headers: { cookie } });
    expect(listed.statusCode).toBe(200);
    expect(listed.body).toContain('Inspect service');

    const missingHost = await app.inject({
      method: 'POST',
      url: '/api/command-runs',
      headers: { cookie },
      payload: { command: 'uname -a', hostIds: ['missing-host'], variables: {}, concurrency: 1, timeoutMs: 1_000, persistOutput: false, confirmed: true }
    });
    expect(missingHost.statusCode).toBe(404);
    expect(JSON.parse(missingHost.body).error.code).toBe('HOST_NOT_FOUND');

    const createdHost = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: { name: 'Batch target', address: '127.0.0.1', username: 'deploy', auth: { type: 'password', password: 'not-stored-in-response' } }
    });
    expect(createdHost.statusCode).toBe(201);
    const hostId = JSON.parse(createdHost.body).id as string;
    const queued = await app.inject({
      method: 'POST',
      url: '/api/command-runs',
      headers: { cookie },
      payload: {
        command: 'uname -a', hostIds: [hostId], variables: {}, concurrency: 1, timeoutMs: 1_000, persistOutput: false, confirmed: true,
        targetSelection: { hostIds: [hostId], source: 'servers', capturedAt: '2026-09-16T09:00:00.000Z', displayNames: ['Batch target'] }
      }
    });
    expect(queued.statusCode).toBe(202);
    expect(JSON.parse(queued.body)).toEqual(expect.objectContaining({ requestId: expect.stringMatching(/^req_/u), targetSelection: expect.objectContaining({ source: 'servers', displayNames: ['Batch target'] }) }));
  });
});
