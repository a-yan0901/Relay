import { randomUUID } from 'node:crypto';

import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';

import { AppError } from '../shared/errors.js';
import { createWebCapabilitySet } from '../shared/core/capabilities.js';
import {
  AppConfigRepository,
  AccountRepository,
  AuditRepository,
  GroupRepository,
  HostRepository,
  IdentityRepository,
  SnippetRepository
} from './db/repositories.js';
import { registerSetupRoutes, type AppRuntimeConfig } from './api/setup-routes.js';
import { registerGroupRoutes } from './api/group-routes.js';
import { registerHostRoutes } from './api/host-routes.js';
import { registerWorkspaceRoutes } from './api/workspace-routes.js';
import { registerVaultRoutes } from './api/vault-routes.js';
import { registerSshImportRoutes } from './api/ssh-import-routes.js';
import { registerSftpRoutes } from './api/sftp-routes.js';
import { registerCommandRoutes } from './api/command-routes.js';
import { registerAuditRoutes } from './api/audit-routes.js';
import { SessionStore } from './auth/session-store.js';
import { AccountSessionStore } from './account/account-session-store.js';
import { AccountService } from './account/account-service.js';
import { registerAccountRoutes } from './account/account-routes.js';
import type { SqliteDatabase } from './db/database.js';
import { WorkspaceRepository } from './workspace/workspace-repository.js';
import { WorkspaceService } from './workspace/workspace-service.js';
import { VaultBundleService } from './workspace/vault-bundle-service.js';
import { SshImportService } from './workspace/ssh-import-service.js';
import { VaultService } from './vault/vault-service.js';
import { Ssh2Adapter, Ssh2ResourceAdapter } from './ssh/ssh2-adapter.js';
import { ConnectionPathResolver } from './ssh/connection-path.js';
import { createConnectionResourceProvider } from './ssh/connection-resource-provider.js';
import { SshSessionManager } from './ssh/session-manager.js';
import type { SshSessionManagerPort } from './ssh/types.js';
import { registerTerminalGateway } from './ws/terminal-gateway.js';
import { OperationEventBus, registerOperationGateway } from './ws/operation-gateway.js';
import { SftpService, type SftpResourceProvider } from './sftp/sftp-service.js';
import { TransferManager } from './sftp/transfer-manager.js';
import { openSftpResource } from './sftp/sftp-adapter.js';
import { SnippetService } from './automation/snippet-service.js';
import { CommandRunStore } from './automation/command-run-store.js';
import { CommandRunner } from './automation/command-runner.js';
import { AuditService } from './audit/audit-service.js';
import { IdentityService } from './identity/identity-service.js';
import { registerIdentityRoutes } from './api/identity-routes.js';
import { registerSyncRoutes } from './sync/sync-routes.js';
import {
  SyncCoordinator,
  SyncService,
  createDefaultBlindSyncStore
} from './sync/sync-service.js';
import type { SyncCoordinatorPort, SyncServiceContract, SyncTransport } from './sync/sync-service.js';
import { SyncSnapshotService } from './sync/sync-snapshot.js';

export interface AppDependencies {
  database: SqliteDatabase;
  config: AppRuntimeConfig;
  serviceInstanceId?: string;
  appConfigRepository?: AppConfigRepository;
  sessionStore?: SessionStore;
  accountSessionStore?: AccountSessionStore;
  accountService?: AccountService;
  vaultService?: VaultService;
  hostRepository?: HostRepository;
  groupRepository?: GroupRepository;
  auditRepository?: AuditRepository;
  sshSessionManager?: SshSessionManagerPort;
  workspaceService?: WorkspaceService;
  vaultBundleService?: VaultBundleService;
  sshImportService?: SshImportService;
  connectionPathResolver?: ConnectionPathResolver;
  sftpService?: SftpService;
  transferManager?: TransferManager;
  operationBus?: OperationEventBus;
  snippetService?: SnippetService;
  commandRunner?: CommandRunner;
  auditService?: AuditService;
  identityService?: IdentityService;
  syncService?: SyncServiceContract;
  syncCoordinator?: SyncCoordinatorPort;
  syncTransport?: SyncTransport;
}

export interface BuiltAppDependencies {
  appConfigRepository: AppConfigRepository;
  sessionStore: SessionStore;
  accountSessionStore: AccountSessionStore;
  accountService: AccountService;
  vaultService: VaultService;
  hostRepository: HostRepository;
  groupRepository: GroupRepository;
  auditRepository: AuditRepository;
  identityService: IdentityService;
  syncService: SyncServiceContract;
  syncCoordinator: SyncCoordinatorPort;
}

const isMutatingMethod = (method: string): boolean => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method);

export const buildApp = async (dependencies: AppDependencies): Promise<FastifyInstance> => {
  const appConfigRepository = dependencies.appConfigRepository ?? new AppConfigRepository(dependencies.database);
  const sessionStore = dependencies.sessionStore ?? new SessionStore({
    idleTimeoutMs: dependencies.config.sessionIdleTimeoutMs
  });
  const accountSessionStore = dependencies.accountSessionStore ?? new AccountSessionStore();
  const accountRepository = new AccountRepository(dependencies.database);
  const accountService = dependencies.accountService ?? new AccountService({
    accountRepository,
    sessionStore: accountSessionStore
  });
  const vaultService = dependencies.vaultService ?? new VaultService();
  const hostRepository = dependencies.hostRepository ?? new HostRepository(dependencies.database, 'default');
  const groupRepository = dependencies.groupRepository ?? new GroupRepository(dependencies.database, 'default');
  const auditRepository = dependencies.auditRepository ?? new AuditRepository(dependencies.database, 'default');
  const auditService = dependencies.auditService ?? new AuditService(auditRepository);
  const identityService = dependencies.identityService ?? new IdentityService({ database: dependencies.database, vaultService });
  const workspaceRepository = new WorkspaceRepository(dependencies.database);
  const workspaceService = dependencies.workspaceService ?? new WorkspaceService(workspaceRepository);
  const vaultBundleService = dependencies.vaultBundleService ?? new VaultBundleService({
    ownerId: 'default',
    database: dependencies.database,
    hostRepository,
    groupRepository,
    vaultService,
    identityService
  });
  const sshImportService = dependencies.sshImportService ?? new SshImportService({
    ownerId: 'default', database: dependencies.database, hostRepository, groupRepository, vaultService, identityService
  });
  const sshSessionManager = dependencies.sshSessionManager ?? new SshSessionManager({
    adapter: new Ssh2Adapter(),
    maxSessions: dependencies.config.maxSessions
  });
  const connectionPathResolver = dependencies.connectionPathResolver ?? new ConnectionPathResolver({
    get: (id, ownerId) => ownerId === 'default' ? hostRepository.getForConnection(id) : null,
    list: (ownerId) => ownerId === 'default' ? hostRepository.listMetadata() : []
  });
  const connectionAdapter = new Ssh2ResourceAdapter();
  const connectionResourceProvider = createConnectionResourceProvider({
    ownerId: 'default',
    hostRepository,
    connectionPathResolver,
    vaultService,
    groupRepository,
    identityService,
    adapter: connectionAdapter
  });
  const sftpResourceProvider: SftpResourceProvider = {
    open: async (hostId, sessionKey) => {
      if (!sessionKey) throw new AppError('SESSION_INVALID');
      const lease = await connectionResourceProvider.open(hostId, sessionKey);
      try {
        const resource = await openSftpResource(lease.resource);
        return { resource, close: async () => { resource.close(); await lease.close(); } };
      } catch (error) {
        await lease.close();
        throw error;
      }
    }
  };
  const operationBus = dependencies.operationBus ?? new OperationEventBus();
  const sftpService = dependencies.sftpService ?? new SftpService({
    ownerId: 'default',
    hostLookup: { hasHost: (hostId, ownerId) => ownerId === 'default' && hostRepository.getForConnection(hostId) !== null },
    resourceProvider: sftpResourceProvider
  });
  const transferManager = dependencies.transferManager ?? new TransferManager({ resourceProvider: sftpResourceProvider, ownerId: 'default', database: dependencies.database });
  const snippetService = dependencies.snippetService ?? new SnippetService({ ownerId: 'default', database: dependencies.database, vaultService });
  const syncSnapshotService = new SyncSnapshotService({
    ownerId: 'default',
    database: dependencies.database,
    bundleService: vaultBundleService,
    workspaceService,
    workspaceRepository,
    snippetService,
    snippetRepository: new SnippetRepository(dependencies.database, 'default'),
    hostRepository,
    groupRepository,
    identityRepository: new IdentityRepository(dependencies.database, 'default'),
    vaultService
  });
  const syncService = dependencies.syncService ?? new SyncService({
    store: createDefaultBlindSyncStore(dependencies.database),
    snapshotService: syncSnapshotService
  });
  const syncCoordinator = dependencies.syncCoordinator ?? new SyncCoordinator({
    syncService,
    accountService,
    sessionStore,
    appConfigRepository,
    transport: dependencies.syncTransport
  });
  const commandRunner = dependencies.commandRunner ?? new CommandRunner({
    ownerId: 'default',
    hostLookup: { get: (hostId, ownerId) => ownerId === 'default' ? hostRepository.getForConnection(hostId) : null },
    resourceProvider: connectionResourceProvider,
    store: new CommandRunStore({ ownerId: 'default', database: dependencies.database, vaultService }),
    operationBus,
    onCompleted: async (run) => { await auditService.recordCommandSummary(run); }
  });
  const appDependencies: BuiltAppDependencies = {
    appConfigRepository,
    sessionStore,
    accountSessionStore,
    accountService,
    vaultService,
    hostRepository,
    groupRepository,
    auditRepository,
    identityService,
    syncService,
    syncCoordinator
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

  app.addHook('onClose', async () => {
    syncCoordinator.close();
  });

  await app.register(cookie);
  await app.register(helmet);
  await app.register(rateLimit, {
    global: true,
    max: dependencies.config.rateLimitMax ?? 120,
    timeWindow: '1 minute'
  });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024 * 1024 } });
  app.addContentTypeParser('application/octet-stream', (_request, payload, done) => done(null, payload));

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

  app.get('/api/capabilities', async (_request, reply) => {
    // maxSessions is a safe server-side upper bound; the browser adapter still
    // intersects it with its own local rendering limit.
    const capabilitySet = createWebCapabilitySet({
      maxWorkspacePanes: dependencies.config.maxSessions,
      accountSyncEnabled: dependencies.config.accountSyncEnabled === true
    });
    reply.send({ client: capabilitySet.client, version: capabilitySet.version, capabilities: capabilitySet.capabilities, limits: capabilitySet.limits });
  });

  await registerSetupRoutes(app, {
    ...appDependencies,
    config: dependencies.config,
    sshSessionManager
  });
  await registerAccountRoutes(app, {
    accountService,
    accountSessionStore,
    auditRepository,
    enabled: dependencies.config.accountSyncEnabled === true,
    secureCookie: dependencies.config.nodeEnv === 'production',
    syncCoordinator
  });
  await registerSyncRoutes(app, {
    enabled: dependencies.config.accountSyncEnabled === true,
    ownerId: 'default',
    accountService,
    appConfigRepository,
    sessionStore,
    syncService,
    syncCoordinator,
    auditRepository
  });
  await registerGroupRoutes(app, {
    groupRepository,
    sessionStore,
    syncCoordinator
  });
  await registerIdentityRoutes(app, { ownerId: 'default', sessionStore, identityService, syncCoordinator });
  await registerHostRoutes(app, {
    ownerId: 'default',
    hostRepository,
    groupRepository,
    sessionStore,
    vaultService,
    auditRepository,
    identityService,
    sshSessionManager,
    syncCoordinator
  });
  await registerWorkspaceRoutes(app, {
    ownerId: 'default',
    workspaceService,
    sessionStore,
    auditRepository,
    syncCoordinator
  });
  await registerVaultRoutes(app, {
    ownerId: 'default',
    vaultBundleService,
    sessionStore,
    auditRepository,
    syncCoordinator
  });
  await registerSshImportRoutes(app, { sessionStore, auditRepository, sshImportService, syncCoordinator });
  await registerSftpRoutes(app, { ownerId: 'default', sessionStore, sftpService, transferManager, operationBus, auditRepository });
  await registerCommandRoutes(app, { ownerId: 'default', sessionStore, snippetService, commandRunner, auditRepository, syncCoordinator });
  await registerAuditRoutes(app, { sessionStore, auditService });
  await registerOperationGateway(app, { ownerId: 'default', config: dependencies.config, sessionStore, eventBus: operationBus });
  await registerTerminalGateway(app, {
    ownerId: 'default',
    config: dependencies.config,
    serviceInstanceId: dependencies.serviceInstanceId ?? randomUUID(),
    sessionStore,
    hostRepository,
    groupRepository,
    auditRepository,
    vaultService,
    identityService,
    sessionManager: sshSessionManager,
    connectionPathResolver
  });

  return app;
};
