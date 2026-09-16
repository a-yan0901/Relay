import { z } from 'zod';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { AppError } from '../../shared/errors.js';
import { AppConfigRepository } from '../db/repositories.js';
import { clearSessionCookie, getSessionId, setSessionCookie } from '../auth/session-cookie.js';
import { SessionStore } from '../auth/session-store.js';
import { VaultService } from '../vault/vault-service.js';
import type { SshSessionManagerPort } from '../ssh/types.js';
import type { AppRuntimeConfig } from '../config.js';
import type { AccountService } from '../account/account-service.js';
import { getAccountSessionId } from '../auth/account-cookie.js';
import { ARGON2ID_PARAMS, VAULT_VERSION, type VaultConfig } from '../vault/types.js';

export type { AppRuntimeConfig } from '../config.js';

export interface SetupRouteDependencies {
  appConfigRepository: AppConfigRepository;
  sessionStore: SessionStore;
  vaultService: VaultService;
  config: AppRuntimeConfig;
  sshSessionManager?: SshSessionManagerPort;
  accountService?: AccountService;
}

const masterPasswordSchema = z.object({
  masterPassword: z.string().min(1).max(4096)
}).strict();

const encryptedKeySchema = z.object({
  version: z.literal(VAULT_VERSION),
  nonce: z.string().min(1).max(256),
  ciphertext: z.string().max(64 * 1024 * 1024),
  authTag: z.string().min(1).max(256),
  aad: z.string().min(1).max(1024)
}).strict();

const fromSyncSchema = z.object({
  masterPassword: z.string().min(1).max(4096),
  vaultUnlockEnvelope: z.object({
    version: z.literal(VAULT_VERSION),
    kdf: z.object({
      algorithm: z.literal(ARGON2ID_PARAMS.algorithm),
      salt: z.string().min(1).max(256),
      memoryCost: z.literal(ARGON2ID_PARAMS.memoryCost),
      timeCost: z.literal(ARGON2ID_PARAMS.timeCost),
      parallelism: z.literal(ARGON2ID_PARAMS.parallelism),
      hashLength: z.literal(ARGON2ID_PARAMS.hashLength)
    }).strict(),
    wrappedVaultKey: encryptedKeySchema
  }).strict()
}).strict();

const parseMasterPassword = (body: unknown): string => {
  try {
    return masterPasswordSchema.parse(body).masterPassword;
  } catch {
    throw new AppError('MASTER_PASSWORD_INVALID');
  }
};

const parseFromSyncBody = (body: unknown): { masterPassword: string; vaultConfig: VaultConfig } => {
  const parsed = fromSyncSchema.safeParse(body);
  if (!parsed.success) throw new AppError('SYNC_PAYLOAD_INVALID');
  return {
    masterPassword: parsed.data.masterPassword,
    vaultConfig: {
      version: VAULT_VERSION,
      kdf: parsed.data.vaultUnlockEnvelope.kdf,
      wrappedVaultKey: parsed.data.vaultUnlockEnvelope.wrappedVaultKey
    }
  };
};

const sendSessionStatus = (reply: FastifyReply, initialized: boolean, locked: boolean): void => {
  reply.send({ initialized, locked });
};

const requireSession = (request: FastifyRequest, dependencies: SetupRouteDependencies): string => {
  const sessionId = getSessionId(request);
  if (!sessionId || !dependencies.sessionStore.get(sessionId)) {
    throw new AppError('SESSION_INVALID');
  }
  return sessionId;
};

const requireAccountSession = (request: FastifyRequest, dependencies: SetupRouteDependencies): void => {
  const accountSessionId = getAccountSessionId(request);
  if (!dependencies.accountService || !accountSessionId || !dependencies.accountService.status(accountSessionId)) {
    throw new AppError('ACCOUNT_SESSION_INVALID');
  }
};

export const registerSetupRoutes = async (
  app: FastifyInstance,
  dependencies: SetupRouteDependencies
): Promise<void> => {
  app.get('/api/setup/status', async (request, reply) => {
    const initialized = dependencies.appConfigRepository.get() !== null;
    const sessionId = getSessionId(request);
    const locked = !sessionId || dependencies.sessionStore.get(sessionId) === null;
    sendSessionStatus(reply, initialized, locked);
  });

  app.post('/api/setup', async (request, reply) => {
    if (dependencies.appConfigRepository.get() !== null) {
      throw new AppError('SETUP_ALREADY_COMPLETE');
    }

    const masterPassword = parseMasterPassword(request.body);
    const created = await dependencies.vaultService.create(masterPassword);
    let sessionTransferred = false;

    try {
      dependencies.appConfigRepository.create(created.config);
      const sessionId = dependencies.sessionStore.create(created.vaultKey);
      sessionTransferred = true;
      setSessionCookie(reply, sessionId, { secure: dependencies.config.nodeEnv === 'production' });
      reply.code(201).send({ initialized: true, locked: false });
    } finally {
      if (!sessionTransferred) {
        created.vaultKey.fill(0);
      }
    }
  });

  app.post('/api/setup/from-sync', async (request, reply) => {
    if (dependencies.config.accountSyncEnabled !== true) throw new AppError('CAPABILITY_UNAVAILABLE');
    if (dependencies.appConfigRepository.get() !== null) throw new AppError('SETUP_ALREADY_COMPLETE');
    requireAccountSession(request, dependencies);
    const { masterPassword, vaultConfig } = parseFromSyncBody(request.body);
    const vaultKey = await dependencies.vaultService.unlock(masterPassword, vaultConfig);
    let sessionTransferred = false;
    try {
      dependencies.appConfigRepository.create(vaultConfig);
      const sessionId = dependencies.sessionStore.create(vaultKey);
      sessionTransferred = true;
      setSessionCookie(reply, sessionId, { secure: dependencies.config.nodeEnv === 'production' });
      reply.code(201).send({ initialized: true, locked: false });
    } finally {
      if (!sessionTransferred) vaultKey.fill(0);
    }
  });

  app.post('/api/session/unlock', async (request, reply) => {
    const config = dependencies.appConfigRepository.get();
    if (!config) {
      throw new AppError('VAULT_NOT_INITIALIZED');
    }

    const masterPassword = parseMasterPassword(request.body);
    const vaultKey = await dependencies.vaultService.unlock(masterPassword, config.vaultConfig);
    let sessionTransferred = false;

    try {
      const sessionId = dependencies.sessionStore.create(vaultKey);
      sessionTransferred = true;
      setSessionCookie(reply, sessionId, { secure: dependencies.config.nodeEnv === 'production' });
      reply.send({ initialized: true, locked: false });
    } finally {
      if (!sessionTransferred) {
        vaultKey.fill(0);
      }
    }
  });

  app.get('/api/session', async (request, reply) => {
    const initialized = dependencies.appConfigRepository.get() !== null;
    const sessionId = getSessionId(request);
    const locked = !sessionId || dependencies.sessionStore.get(sessionId) === null;
    sendSessionStatus(reply, initialized, locked);
  });

  app.post('/api/session/lock', async (request, reply) => {
    const sessionId = requireSession(request, dependencies);
    dependencies.sessionStore.revoke(sessionId);
    dependencies.sshSessionManager?.closeAll?.();
    clearSessionCookie(reply, { secure: dependencies.config.nodeEnv === 'production' });
    reply.code(204).send();
  });
};
