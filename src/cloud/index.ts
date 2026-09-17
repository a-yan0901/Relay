import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FastifyInstance } from 'fastify';

import { CloudAccountRepository } from './account-repository.js';
import { CloudAuthService } from './auth-service.js';
import { buildCloudApp } from './app.js';
import { loadCloudConfig, type CloudRuntimeConfig } from './config.js';
import { MySqlCloudDatabase } from './database.js';
import { applyCloudSchema } from './schema.js';
import { CloudSnapshotRepository } from './snapshot-repository.js';
import { CloudKeyRepository } from './key-repository.js';
import { CloudWorkspaceRepository } from './workspace-repository.js';

export interface CloudServerHandle {
  app: FastifyInstance;
  database: MySqlCloudDatabase;
  close(): Promise<void>;
}

export const createCloudServer = async (config: CloudRuntimeConfig = loadCloudConfig()): Promise<CloudServerHandle> => {
  const database = new MySqlCloudDatabase(config);
  try {
    await applyCloudSchema(database);
    const accountRepository = new CloudAccountRepository(database);
    const workspaces = new CloudWorkspaceRepository(database);
    const auth = new CloudAuthService(accountRepository, config.session, Date.now, {
      onDeviceCreated: async (accountId, deviceId, _deviceLabel, at) => {
        await workspaces.ensurePrimaryWorkspace(accountId, deviceId, 'v1:', at);
      }
    });
    const snapshots = new CloudSnapshotRepository(database);
    const keys = new CloudKeyRepository(database);
    const app = await buildCloudApp({ config, auth, snapshots, keys, workspaces });
    let closed = false;
    return {
      app,
      database,
      async close() {
        if (closed) return;
        closed = true;
        await app.close();
        await database.close();
      }
    };
  } catch (error) {
    await database.close().catch(() => undefined);
    throw error;
  }
};

export const startCloudServer = async (): Promise<CloudServerHandle> => {
  const config = loadCloudConfig();
  const handle = await createCloudServer(config);
  await handle.app.listen({ host: config.host, port: config.port });
  handle.app.log.info({ host: config.host, port: config.port }, 'relay cloud service started');
  return handle;
};

const entrypointUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entrypointUrl === import.meta.url) {
  void startCloudServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'cloud service startup failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
