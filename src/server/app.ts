import { randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';

import { AppError } from '../shared/errors.js';
import {
  AppConfigRepository,
  AuditRepository,
  GroupRepository,
  HostRepository
} from './db/repositories.js';
import { registerSetupRoutes, type AppRuntimeConfig } from './api/setup-routes.js';
import { SessionStore } from './auth/session-store.js';
import type { SqliteDatabase } from './db/database.js';
import { VaultService } from './vault/vault-service.js';
import type { SshSessionManagerPort } from './ssh/types.js';

export interface AppDependencies {
  database: SqliteDatabase;
  config: AppRuntimeConfig;
  appConfigRepository?: AppConfigRepository;
  sessionStore?: SessionStore;
  vaultService?: VaultService;
  hostRepository?: HostRepository;
  groupRepository?: GroupRepository;
  auditRepository?: AuditRepository;
  sshSessionManager?: SshSessionManagerPort;
}

export interface BuiltAppDependencies {
  appConfigRepository: AppConfigRepository;
  sessionStore: SessionStore;
  vaultService: VaultService;
  hostRepository: HostRepository;
  groupRepository: GroupRepository;
  auditRepository: AuditRepository;
}

const isMutatingMethod = (method: string): boolean => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);

export const buildApp = async (dependencies: AppDependencies): Promise<FastifyInstance> => {
  const appConfigRepository = dependencies.appConfigRepository ?? new AppConfigRepository(dependencies.database);
  const sessionStore = dependencies.sessionStore ?? new SessionStore({
    idleTimeoutMs: dependencies.config.sessionIdleTimeoutMs
  });
  const vaultService = dependencies.vaultService ?? new VaultService();
  const hostRepository = dependencies.hostRepository ?? new HostRepository(dependencies.database, 'default');
  const groupRepository = dependencies.groupRepository ?? new GroupRepository(dependencies.database, 'default');
  const auditRepository = dependencies.auditRepository ?? new AuditRepository(dependencies.database, 'default');
  const appDependencies: BuiltAppDependencies = {
    appConfigRepository,
    sessionStore,
    vaultService,
    hostRepository,
    groupRepository,
    auditRepository
  };

  const app = Fastify({
    genReqId: () => `req_${randomUUID()}`,
    logger: {
      level: dependencies.config.logLevel,
      serializers: {
        req: (request) => ({
          id: request.id,
          method: request.method,
          url: request.url,
          remoteAddress: request.ip
        }),
        res: (response) => ({ statusCode: response.statusCode })
      }
    }
  });

  await app.register(cookie);
  await app.register(helmet);
  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute'
  });
  await app.register(websocket);

  app.addHook('onRequest', async (request) => {
    if (!isMutatingMethod(request.method) || !request.headers.origin) {
      return;
    }

    if (!dependencies.config.trustedOrigins.includes(request.headers.origin)) {
      throw new AppError('PROTOCOL_INVALID_MESSAGE', '来源不受信任', 403);
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('x-request-id', request.id);
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          requestId: request.id
        }
      });
      return;
    }

    const statusCodeValue = error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode
      : undefined;
    const statusCode = statusCodeValue !== undefined && statusCodeValue >= 400 && statusCodeValue < 500
      ? statusCodeValue
      : 500;
    request.log.error({
      err: {
        name: error instanceof Error ? error.name : 'UnknownError',
        code: 'INTERNAL_ERROR'
      }
    }, 'request failed');
    reply.status(statusCode).send({
      error: {
        code: statusCode === 400 ? 'PROTOCOL_INVALID_MESSAGE' : 'INTERNAL_ERROR',
        message: statusCode === 400 ? '请求格式无效' : '服务暂时不可用',
        requestId: request.id
      }
    });
  });

  await registerSetupRoutes(app, {
    ...appDependencies,
    config: dependencies.config,
    sshSessionManager: dependencies.sshSessionManager
  });

  return app;
};
