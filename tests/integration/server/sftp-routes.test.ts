import { afterEach, describe, expect, it, vi } from 'vitest';

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
    const pageResponse = await app.inject({ method: 'GET', url: '/api/sftp/host-1/list-page?path=/&limit=128&filter=log', headers: { cookie } });
    expect(pageResponse.statusCode).toBe(404);
    expect(pageResponse.json().error.code).toBe('HOST_NOT_FOUND');

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

  it('forwards raw upload chunks and the resume checkpoint without building multipart content', async () => {
    const job: TransferJob = {
      id: 'upload-1',
      kind: 'upload',
      hostId: 'host-1',
      sourcePath: 'local.txt',
      targetPath: '/remote.txt',
      status: 'queued',
      completedBytes: 5,
      totalBytes: 11,
      checkpoint: { transferId: 'upload-1', offset: 5, totalBytes: 11, checksum: 'a'.repeat(64) },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const consumeUpload = vi.fn(async (_id: string, source: AsyncIterable<Uint8Array>, _onUpdate: unknown, _sessionKey: Buffer, resume: unknown) => {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe(' world');
      expect(resume).toEqual({ transferId: 'upload-1', expectedOffset: 5, checksum: 'a'.repeat(64) });
      return { ...job, status: 'completed' as const, completedBytes: 11 };
    });
    const transferManager = { get: async () => job, consumeUpload } as unknown as TransferManager;
    const { app, cookie } = await setup(transferManager);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/transfers/upload-1/content',
      headers: {
        cookie,
        'content-type': 'application/octet-stream',
        'x-transfer-offset': '5',
        'x-transfer-checksum': 'a'.repeat(64)
      },
      payload: Buffer.from(' world')
    });

    expect(response.statusCode).toBe(200);
    expect(consumeUpload).toHaveBeenCalledOnce();
  });

  it('forwards browser-compatible bounded upload chunk metadata', async () => {
    const job: TransferJob = {
      id: 'upload-chunk-1',
      kind: 'upload',
      hostId: 'host-1',
      sourcePath: 'local.txt',
      targetPath: '/remote.txt',
      status: 'running',
      completedBytes: 5,
      totalBytes: 11,
      checkpoint: { transferId: 'upload-chunk-1', offset: 5, totalBytes: 11, checksum: 'b'.repeat(64) },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    const consumeUploadChunk = vi.fn(async (_id: string, source: AsyncIterable<Uint8Array>, _onUpdate: unknown, _sessionKey: Buffer, resume: unknown, nextChecksum: string, final: boolean) => {
      const chunks: Buffer[] = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe(' world');
      expect(resume).toEqual({ transferId: 'upload-chunk-1', expectedOffset: 5, checksum: 'b'.repeat(64) });
      expect(nextChecksum).toBe('c'.repeat(64));
      expect(final).toBe(true);
      return { ...job, status: 'completed' as const, completedBytes: 11 };
    });
    const transferManager = { get: async () => job, consumeUploadChunk } as unknown as TransferManager;
    const { app, cookie } = await setup(transferManager);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/transfers/upload-chunk-1/content/chunk',
      headers: {
        cookie,
        'content-type': 'application/octet-stream',
        'x-transfer-offset': '5',
        'x-transfer-checksum': 'b'.repeat(64),
        'x-transfer-next-checksum': 'c'.repeat(64),
        'x-transfer-final': 'true'
      },
      payload: Buffer.from(' world')
    });

    expect(response.statusCode).toBe(200);
    expect(consumeUploadChunk).toHaveBeenCalledOnce();
  });

  it('exposes an explicit pause endpoint for resumable transfers', async () => {
    const pause = vi.fn(async () => {});
    const transferManager = { pause, get: async () => null } as unknown as TransferManager;
    const { app, cookie } = await setup(transferManager);

    const response = await app.inject({
      method: 'POST',
      url: '/api/transfers/transfer-pause/pause',
      headers: { cookie }
    });

    expect(response.statusCode).toBe(204);
    expect(pause).toHaveBeenCalledWith('transfer-pause', expect.anything());
  });
});
