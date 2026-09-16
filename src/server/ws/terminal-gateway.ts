import { randomUUID } from 'node:crypto';

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';

import { AppError, type AppErrorCode } from '../../shared/errors.js';
import {
  parseTerminalClientMessage,
  type TerminalClientMessage,
  type TerminalServerEvent
} from '../../shared/protocol.js';
import { connectionDiagnosticToOperationDiagnostic } from '../../shared/core/state-machines.js';
import { storedHostCredentialSchema, type HostCredentialInput, type StoredHostCredential } from '../../shared/validation.js';
import { resolveConnectionConfiguration } from '../../shared/core/connection-resolution.js';
import type { GroupNode } from '../../shared/core/models.js';
import { getSessionId } from '../auth/session-cookie.js';
import { SessionStore } from '../auth/session-store.js';
import { AuditRepository, HostRepository } from '../db/repositories.js';
import type { GroupRepository } from '../db/repositories.js';
import { VaultService, type EncryptedJson } from '../vault/vault-service.js';
import { HostKeyPolicy } from '../ssh/host-key-policy.js';
import { ConnectionPathResolver } from '../ssh/connection-path.js';
import type { IdentityService } from '../identity/identity-service.js';
import type {
  SshChannel,
  SshConnectCallbacks,
  SshConnectConfig,
  SshSessionManagerPort
} from '../ssh/types.js';
import type { AppRuntimeConfig } from '../api/setup-routes.js';

const MAX_FRAME_BYTES = 64 * 1024;

export type TerminalGatewayCloseReason = 'explicit' | 'socket' | 'protocol';
export type TerminalGatewayLifecycle = 'idle' | 'open' | 'closed';

export interface TerminalGatewayStateOptions {
  getPendingFingerprint?: () => string | undefined;
  onMessage: (message: TerminalClientMessage) => void | Promise<void>;
  onBinary: (data: Buffer) => void | Promise<void>;
  onClose: (reason: TerminalGatewayCloseReason) => void | Promise<void>;
}

export class TerminalGatewayState {
  private readonly options: TerminalGatewayStateOptions;
  private currentLifecycle: TerminalGatewayLifecycle = 'idle';

  constructor(options: TerminalGatewayStateOptions) {
    this.options = options;
  }

  get lifecycle(): TerminalGatewayLifecycle {
    return this.currentLifecycle;
  }

  async receive(payload: string | Buffer, isBinary: boolean): Promise<void> {
    if (this.currentLifecycle === 'closed') {
      throw new AppError('PROTOCOL_INVALID_MESSAGE');
    }

    if (isBinary) {
      const data = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      if (data.byteLength > MAX_FRAME_BYTES || this.currentLifecycle !== 'open') {
        throw new AppError('PROTOCOL_INVALID_MESSAGE');
      }
      await this.options.onBinary(Buffer.from(data));
      return;
    }

    const text = typeof payload === 'string' ? payload : payload.toString('utf8');
    if (Buffer.byteLength(text, 'utf8') > MAX_FRAME_BYTES) {
      throw new AppError('PROTOCOL_INVALID_MESSAGE');
    }

    let decoded: unknown;
    try {
      decoded = text.length === 0 ? null : JSON.parse(text);
    } catch {
      throw new AppError('PROTOCOL_INVALID_MESSAGE');
    }
    const message = parseTerminalClientMessage(decoded, {
      pendingFingerprint: this.options.getPendingFingerprint?.()
    });
    if (message.type === 'open') {
      if (this.currentLifecycle !== 'idle') {
        throw new AppError('PROTOCOL_INVALID_MESSAGE');
      }
      this.currentLifecycle = 'open';
    } else if (this.currentLifecycle !== 'open') {
      throw new AppError('PROTOCOL_INVALID_MESSAGE');
    }

    if (message.type === 'close') {
      await this.options.onMessage(message);
      this.closeExplicit();
      return;
    }

    await this.options.onMessage(message);
  }

  closeExplicit(): void {
    if (this.currentLifecycle === 'closed') {
      return;
    }
    this.currentLifecycle = 'closed';
    void this.options.onClose('explicit');
  }

  closeForProtocol(): void {
    if (this.currentLifecycle === 'closed') {
      return;
    }
    this.currentLifecycle = 'closed';
    void this.options.onClose('protocol');
  }

  socketClosed(): void {
    if (this.currentLifecycle === 'closed') {
      return;
    }
    this.currentLifecycle = 'closed';
    void this.options.onClose('socket');
  }
}

export interface TerminalGatewayDependencies {
  ownerId: string;
  config: Pick<AppRuntimeConfig, 'trustedOrigins'>;
  serviceInstanceId?: string;
  sessionStore: SessionStore;
  hostRepository: HostRepository;
  groupRepository?: GroupRepository;
  auditRepository: AuditRepository;
  vaultService: VaultService;
  identityService?: IdentityService;
  sessionManager: SshSessionManagerPort;
  connectionPathResolver?: ConnectionPathResolver;
}

const websocketHandshake = async (
  request: FastifyRequest,
  dependencies: TerminalGatewayDependencies
): Promise<void> => {
  const sessionId = getSessionId(request);
  if (!sessionId || !dependencies.sessionStore.get(sessionId)) {
    throw new AppError('SESSION_INVALID');
  }

  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !dependencies.config.trustedOrigins.includes(origin)) {
    throw new AppError('PROTOCOL_INVALID_MESSAGE', '来源不受信任', 403);
  }
};

const asRawBuffer = (data: RawData): Buffer => {
  if (Buffer.isBuffer(data)) {
    return data;
  }
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  }
  return Buffer.from(data);
};

const parseCredentialBlob = (value: string): EncryptedJson => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      !('version' in parsed) ||
      !('nonce' in parsed) ||
      !('ciphertext' in parsed) ||
      !('authTag' in parsed) ||
      !('aad' in parsed)
    ) {
      throw new Error('invalid credential blob');
    }
    return parsed as EncryptedJson;
  } catch {
    throw new AppError('VAULT_CRYPTO_FAILED');
  }
};

const credentialAad = (hostId: string): string => `host:${hostId}:credentials:v1`;

const safeError = (error: unknown): { code: AppErrorCode; message: string } => {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message };
  }
  return {
    code: 'SSH_CONNECTION_FAILED',
    message: '无法连接远程服务器'
  };
};

export const registerTerminalGateway = async (
  app: FastifyInstance,
  dependencies: TerminalGatewayDependencies
): Promise<void> => {
  const serviceInstanceId = dependencies.serviceInstanceId ?? randomUUID();
  app.get('/ws/terminal', {
    websocket: true,
    preValidation: async (request) => websocketHandshake(request, dependencies)
  }, (socket: WebSocket, request: FastifyRequest) => {
    const authenticatedSessionId = getSessionId(request);
    if (!authenticatedSessionId) {
      socket.close(1008, 'session required');
      return;
    }

    let managerSessionId: string | undefined;
    let channel: SshChannel | undefined;
    let hostKeyPolicy: HostKeyPolicy | undefined;
    const hostKeyPolicies = new Map<string, HostKeyPolicy>();
    let pendingResize: { cols: number; rows: number } | undefined;
    let active = true;
    let cleanupStarted = false;
    let lastStatus: Extract<TerminalServerEvent, { type: 'status' }>['state'] | undefined;
    let hostMarkedConnected = false;
    let pendingOpen: Extract<TerminalClientMessage, { type: 'open' }> | undefined;
    let pendingCredentialHostId: string | undefined;
    let pendingCredentialAuthType: 'password' | 'private_key' | undefined;
    const sessionCredentials = new Map<string, HostCredentialInput>();

    const persistSessionCredentials = async (sessionKey: Buffer): Promise<void> => {
      for (const [hostId, credential] of sessionCredentials) {
        const encrypted = await dependencies.vaultService.encryptJson(sessionKey, credentialAad(hostId), credential);
        dependencies.hostRepository.updateHost(hostId, {
          authType: credential.type,
          credentialCiphertext: JSON.stringify(encrypted),
          credentialVersion: 1,
          credentialSource: 'inline',
          identityId: null
        });
      }
    };

    const send = (event: TerminalServerEvent): void => {
      if (active && socket.readyState === 1) {
        socket.send(JSON.stringify(event));
      }
    };

    const sendOutput = (data: Buffer): void => {
      if (active && socket.readyState === 1) {
        socket.send(data);
      }
    };

    const sendStatus = (state: Extract<TerminalServerEvent, { type: 'status' }>['state']): void => {
      if (lastStatus === state) {
        return;
      }
      lastStatus = state;
      send({ type: 'status', state, serviceInstanceId });
    };

    const markHostConnected = (hostId: string): void => {
      if (hostMarkedConnected) return;
      hostMarkedConnected = true;
      dependencies.hostRepository.markConnected(hostId);
    };

    const cleanup = (reason: TerminalGatewayCloseReason): void => {
      if (cleanupStarted) {
        return;
      }
      cleanupStarted = true;
      active = false;
      pendingOpen = undefined;
      pendingCredentialHostId = undefined;
      pendingCredentialAuthType = undefined;
      sessionCredentials.clear();
      if (managerSessionId) {
        if (reason === 'socket') {
          dependencies.sessionManager.detach(managerSessionId);
        } else {
          dependencies.sessionManager.close(managerSessionId);
        }
      }
      if (reason !== 'socket' && socket.readyState === 1) {
        socket.close(reason === 'protocol' ? 1008 : 1000);
      }
    };

    const attachChannel = (nextChannel: SshChannel): void => {
      channel = nextChannel;
      nextChannel.on('data', (data) => {
        sendOutput(data);
      });
      nextChannel.on('stderr', (data) => {
        sendOutput(data);
      });
      nextChannel.on('exit', (code, signal) => {
        send({ type: 'exit', code, ...(signal === undefined ? {} : { signal }) });
      });
      nextChannel.on('error', () => {
        send({ type: 'error', code: 'SSH_CONNECTION_FAILED', message: '远程连接异常' });
      });
      nextChannel.on('close', () => {
        if (active) {
          channel = undefined;
          sendStatus('closed');
        }
      });
      if (pendingResize) {
        nextChannel.resize(pendingResize.cols, pendingResize.rows);
        pendingResize = undefined;
      }
    };

    const openTerminal = async (message: Extract<TerminalClientMessage, { type: 'open' }>): Promise<void> => {
      const row = dependencies.hostRepository.getForConnection(message.hostId);
      if (!row) {
        throw new AppError('HOST_NOT_FOUND');
      }

      if (message.knownServiceInstanceId !== undefined && message.knownServiceInstanceId !== serviceInstanceId) {
        throw new AppError('SESSION_NEEDS_REOPEN');
      }
      managerSessionId = `${authenticatedSessionId}:${message.requestId}`;
      const reattached = dependencies.sessionManager.reattach(managerSessionId, row.id);
      if (reattached) {
        attachChannel(reattached);
        markHostConnected(row.id);
        sendStatus('connected');
        const bufferedOutput = dependencies.sessionManager.getBufferedOutput(managerSessionId, row.id);
        if (bufferedOutput && bufferedOutput.length > 0) {
          sendOutput(bufferedOutput);
        }
        return;
      }

      const path = dependencies.connectionPathResolver?.resolve(row.id, dependencies.ownerId) ?? { targetHostId: row.id, hopCount: 0, hops: [row] };
      const pathRows = path.hops.map((hop) => dependencies.hostRepository.getForConnection(hop.id)).filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);
      if (pathRows.length !== path.hops.length) throw new AppError('HOST_NOT_FOUND');
      const groups: readonly GroupNode[] = dependencies.groupRepository?.list() ?? [];
      const session = dependencies.sessionStore.get(authenticatedSessionId);
      if (!session) throw new AppError('SESSION_INVALID');

      hostKeyPolicies.clear();
      hostKeyPolicy = undefined;
      const pathConfigs: SshConnectConfig[] = [];
      for (const [hopIndex, pathRow] of pathRows.entries()) {
        const knownHostKey = pathRow.hostKeyAlgorithm && pathRow.hostKeyFingerprint
          ? { algorithm: pathRow.hostKeyAlgorithm, fingerprint: pathRow.hostKeyFingerprint }
          : null;
        const policy = new HostKeyPolicy({
          hostId: pathRow.id,
          address: pathRow.address,
          port: pathRow.port,
          knownHostKey,
          hopIndex,
          saveHostKey: (hostId, algorithm, fingerprint) => dependencies.hostRepository.setHostKey(hostId, algorithm, fingerprint)
        });
        hostKeyPolicies.set(pathRow.id, policy);
        const resolved = resolveConnectionConfiguration(pathRow, groups);
        const identityId = pathRow.credentialSource?.type === 'identity'
          ? pathRow.identityId
          : pathRow.credentialSource?.type === 'group' ? resolved.identityId : null;
        let parsedCredential: { success: true; data: StoredHostCredential };
        if (identityId) {
          if (!dependencies.identityService) throw new AppError('IDENTITY_NOT_FOUND');
          const identityCredential = await dependencies.identityService.getCredential(dependencies.ownerId, identityId, session.vaultKey);
          parsedCredential = { success: true, data: identityCredential };
        } else {
          if (pathRow.credentialSource?.type === 'group') throw new AppError('IDENTITY_NOT_FOUND');
          if (pathRow.credentialCiphertext === null) throw new AppError('IMPORT_RECORD_INVALID', '请先在连接时补录凭据');
          const storedCredential = await dependencies.vaultService.decryptJson<StoredHostCredential>(
            session.vaultKey,
            credentialAad(pathRow.id),
            parseCredentialBlob(pathRow.credentialCiphertext)
          );
          const parsed = storedHostCredentialSchema.safeParse(storedCredential);
          if (!parsed.success) throw new AppError('VAULT_CRYPTO_FAILED');
          parsedCredential = parsed;
        }
        const credential = parsedCredential.data.type === 'pending'
          ? sessionCredentials.get(pathRow.id)
          : parsedCredential.data;
        if (!credential) {
          pendingOpen = message;
          pendingCredentialHostId = pathRow.id;
          pendingCredentialAuthType = parsedCredential.data.type === 'pending' ? parsedCredential.data.authType : pathRow.authType;
          sendStatus('awaiting-credential');
          send({
            type: 'credential-required',
            hostId: pathRow.id,
            authType: pendingCredentialAuthType,
            name: pathRow.name,
            address: pathRow.address,
            port: pathRow.port,
            username: pathRow.username
          });
          return;
        }
        pathConfigs.push({
          hostId: pathRow.id,
          address: pathRow.address,
          port: pathRow.port,
          username: pathRow.username,
          auth: credential,
          hostKeyAlgorithm: pathRow.hostKeyAlgorithm,
          hostKeyFingerprint: pathRow.hostKeyFingerprint,
          keepaliveInterval: resolved.profile.keepaliveIntervalMs,
          keepaliveCountMax: resolved.profile.keepaliveCountMax,
          reconnect: resolved.profile.reconnect
        });
      }
      pendingOpen = undefined;
      pendingCredentialHostId = undefined;
      pendingCredentialAuthType = undefined;
      hostKeyPolicy = hostKeyPolicies.get(row.id);
      const targetConfig = pathConfigs.at(-1);
      if (!targetConfig) throw new AppError('CONNECTION_STAGE_FAILED');
      const config: SshConnectConfig = {
        ...targetConfig,
        cols: message.cols,
        rows: message.rows,
        term: message.term ?? 'xterm-256color',
        ...(pathConfigs.length > 1 ? { jumpHosts: pathConfigs.slice(0, -1) } : {})
      };
      const callbacks: SshConnectCallbacks = {
        onStatus: (state) => {
          if (state === 'connected' && sessionCredentials.size > 0) return;
          if (state === 'connected') markHostConnected(row.id);
          sendStatus(state);
        },
        onDiagnostic: (event) => send({
          type: 'diagnostic',
          diagnostic: connectionDiagnosticToOperationDiagnostic(event, {
            operationId: message.requestId,
            requestId: message.requestId
          })
        }),
        onHostKey: async (challenge) => new Promise<boolean>((resolve) => {
          const policy = hostKeyPolicies.get(challenge.hostId ?? row.id) ?? hostKeyPolicy;
          hostKeyPolicy = policy;
          policy?.verifyFingerprint(challenge.fingerprint, challenge.algorithm, (accepted) => {
            if (!accepted && policy?.hasMismatch) {
              send({ type: 'error', code: 'HOST_KEY_MISMATCH', message: '远程主机指纹与已保存指纹不一致' });
            }
            resolve(accepted);
          });
          const pending = policy?.pendingChallenge;
          if (pending) {
            sendStatus('awaiting-host-key');
            send({ type: 'host-key', ...pending });
          }
        })
      };

      sendStatus('connecting');
      try {
        attachChannel(await dependencies.sessionManager.open(managerSessionId, config, callbacks));
        await persistSessionCredentials(session.vaultKey);
        sessionCredentials.clear();
        sendStatus('connected');
        markHostConnected(row.id);
        dependencies.auditRepository.insert({ eventType: 'ssh_connected', hostId: row.id, requestId: message.requestId });
      } catch (error) {
        if ([...hostKeyPolicies.values()].some((policy) => policy.hasMismatch)) {
          throw new AppError('HOST_KEY_MISMATCH');
        }
        throw error;
      }
    };

    const handleMessage = async (message: TerminalClientMessage): Promise<void> => {
      switch (message.type) {
        case 'open':
          await openTerminal(message);
          return;
        case 'resize':
          if (channel) {
            channel.resize(message.cols, message.rows);
          } else {
            pendingResize = { cols: message.cols, rows: message.rows };
          }
          return;
        case 'input':
          channel?.write(message.data);
          return;
        case 'ping':
          send({ type: 'pong' });
          return;
        case 'host-key-decision':
          if (!hostKeyPolicy) throw new AppError('PROTOCOL_INVALID_MESSAGE');
          hostKeyPolicy.decide(message.decision, message.fingerprint);
          return;
        case 'credential': {
          if (!pendingOpen || message.hostId !== pendingCredentialHostId || message.credential.type !== pendingCredentialAuthType) {
            throw new AppError('PROTOCOL_INVALID_MESSAGE');
          }
          sessionCredentials.set(message.hostId, message.credential);
          const nextOpen = pendingOpen;
          pendingOpen = undefined;
          pendingCredentialHostId = undefined;
          pendingCredentialAuthType = undefined;
          await openTerminal(nextOpen);
          return;
        }
        case 'close':
          sendStatus('closed');
          return;
        default:
          return;
      }
    };

    const state = new TerminalGatewayState({
      getPendingFingerprint: () => hostKeyPolicy?.pendingChallenge?.fingerprint,
      onMessage: handleMessage,
      onBinary: (data) => {
        channel?.write(data);
      },
      onClose: cleanup
    });

    socket.on('message', (data, isBinary) => {
      const raw = asRawBuffer(data);
      void state.receive(isBinary ? raw : raw.toString('utf8'), isBinary).catch((error: unknown) => {
        const mapped = safeError(error);
        send({ type: 'error', code: mapped.code, message: mapped.message });
        state.closeForProtocol();
      });
    });
    socket.on('close', () => {
      active = false;
      state.socketClosed();
    });
    socket.on('error', () => {
      active = false;
      state.socketClosed();
    });

  });
};
