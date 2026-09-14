import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

import { buildApp } from './app.js';
import { loadConfig, type AppRuntimeConfig } from './config.js';
import { openDatabase, type SqliteDatabase } from './db/database.js';
import { migrate } from './db/migrations.js';
import { SessionStore } from './auth/session-store.js';
import { Ssh2Adapter } from './ssh/ssh2-adapter.js';
import { SshSessionManager } from './ssh/session-manager.js';
import { VaultService } from './vault/vault-service.js';

export const APP_NAME = 'web-ssh-workspace';
export const APP_VERSION = '0.1.0';

export interface ServerHandle {
  app: FastifyInstance;
  database: SqliteDatabase;
  sessionStore: SessionStore;
  sshSessionManager: SshSessionManager;
  close: () => Promise<void>;
}

export interface ServerAppOptions {
  webRoot?: string;
  version?: string;
}

const registerSystemRoutes = async (app: FastifyInstance, version: string): Promise<void> => {
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/api/version', async () => ({ name: APP_NAME, version }));
};

const registerWebAssets = async (app: FastifyInstance, webRoot: string): Promise<void> => {
  await app.register(fastifyStatic, {
    root: webRoot,
    wildcard: false,
    index: false
  });
  app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  app.setNotFoundHandler((request, reply) => {
    const acceptsHtml = request.headers.accept?.includes('text/html') ?? false;
    if (request.method === 'GET' && acceptsHtml && !request.url.startsWith('/api/') && !request.url.startsWith('/ws/')) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: '请求的资源不存在' } });
  });
};

export const createServerApp = async (
  config: AppRuntimeConfig = loadConfig(),
  options: ServerAppOptions = {}
): Promise<ServerHandle> => {
  if (config.dataDir !== ':memory:') {
    mkdirSync(resolve(config.dataDir), { recursive: true });
  }
  const databasePath = config.dataDir === ':memory:' ? ':memory:' : join(resolve(config.dataDir), 'webssh.sqlite');
  const database = openDatabase(databasePath);
  migrate(database);
  const sessionStore = new SessionStore({ idleTimeoutMs: config.sessionIdleTimeoutMs });
  const sshSessionManager = new SshSessionManager({
    adapter: new Ssh2Adapter(),
    maxSessions: config.maxSessions
  });
  const app = await buildApp({
    database,
    config,
    sessionStore,
    vaultService: new VaultService(),
    sshSessionManager
  });

  try {
    await registerSystemRoutes(app, options.version ?? APP_VERSION);
    if (options.webRoot) await registerWebAssets(app, options.webRoot);
  } catch (error) {
    await app.close().catch(() => undefined);
    sessionStore.revokeAll();
    sshSessionManager.closeAll();
    database.close();
    throw error;
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    sshSessionManager.closeAll();
    sessionStore.revokeAll();
    await app.close();
    database.close();
  };

  return { app, database, sessionStore, sshSessionManager, close };
};

export const startServer = async (): Promise<ServerHandle> => {
  const config = loadConfig();
  const sourceRoot = dirname(fileURLToPath(import.meta.url));
  const webRoot = join(sourceRoot, '../web');
  const handle = await createServerApp(config, { webRoot: existsSync(join(webRoot, 'index.html')) ? webRoot : undefined });
  await handle.app.listen({ port: config.port, host: '0.0.0.0' });
  handle.app.log.info({ port: config.port }, 'web ssh server started');
  return handle;
};

const entrypointUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (entrypointUrl === import.meta.url) {
  void startServer().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'server startup failed';
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
