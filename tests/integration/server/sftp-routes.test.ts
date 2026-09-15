import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/server/app.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';
import type { TransferJob } from '../../../src/shared/core/models.js';
import type { TransferManager } from '../../../src/server/sftp/transfer-manager.js';

const databases: ReturnType<typeof openDatabase>[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];
const MASTER_PASSWORD = 'correct horse battery staple';

const setup = async (transferManager?: TransferManager) => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
  const app = await buildApp({ database, transferManager, config: { nodeEnv: 'test', port: 3000, dataDir: ':memory:', trustedOrigins: ['http://localhost:4173'], sessionIdleTimeoutMs: 60_000, maxSessions: 4, logLevel: 'silent' } });
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

describe('sftp routes', () => {
  it('requires an unlocked session and exposes the route boundary', async () => {
    const { app, cookie } = await setup();
    expect((await app.inject({ method: 'GET', url: '/api/sftp/host-1/list' })).statusCode).toBe(401);
    const response = await app.inject({ method: 'GET', url: '/api/sftp/host-1/list?path=/', headers: { cookie } });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('HOST_NOT_FOUND');

    const transferResponse = await app.inject({
      method: 'POST',
      url: '/api/sftp/host-1/transfers',
      headers: { cookie },
      payload: {
        kind: 'download',
        hostId: 'host-1',
        sourcePath: '/remote.txt',
        targetPath: 'remote.txt'
      }
    });
    expect(transferResponse.statusCode).toBe(404);
    expect(transferResponse.json().error.code).toBe('HOST_NOT_FOUND');
  });

  it('streams download bytes through the HTTP response', async () => {
    const job: TransferJob = {
      id: 'download-1',
      kind: 'download',
      hostId: 'host-1',
      sourcePath: '/remote.txt',
      targetPath: 'remote.txt',
      status: 'queued',
      completedBytes: 0,
      totalBytes: 13,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const transferManager = {
      get: async () => job,
      streamDownload: async function* () { yield Buffer.from('download-data'); }
    } as unknown as TransferManager;
    const { app, cookie } = await setup(transferManager);

    const response = await app.inject({ method: 'GET', url: '/api/transfers/download-1/content', headers: { cookie } });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('download-data');
  });
});
