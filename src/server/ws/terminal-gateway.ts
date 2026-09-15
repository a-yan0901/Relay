import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';

import { AppError, type AppErrorCode } from '../../shared/errors.js';
import {
  parseTerminalClientMessage,
  type TerminalClientMessage,
  type TerminalServerEvent
} from '../../shared/protocol.js';
import type { HostCredentialInput } from '../../shared/validation.js';
import { getSessionId } from '../auth/session-cookie.js';
import { SessionStore } from '../auth/session-store.js';
import { AuditRepository, HostRepository } from '../db/repositories.js';
import { VaultService, type EncryptedJson } from '../vault/vault-service.js';
import { HostKeyPolicy } from '../ssh/host-key-policy.js';
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
  sessionStore: SessionStore;
  hostRepository: HostRepository;
  auditRepository: AuditRepository;
  vaultService: VaultService;
  sessionManager: SshSessionManagerPort;
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
    let pendingResize: { cols: number; rows: number } | undefined;
    let active = true;
    let cleanupStarted = false;
    let lastStatus: Extract<TerminalServerEvent, { type: 'status' }>['state'] | undefined;

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
      send({ type: 'status', state });
    };

    const cleanup = (reason: TerminalGatewayCloseReason): void => {
      if (cleanupStarted) {
        return;
      }
      cleanupStarted = true;
      active = false;
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

      managerSessionId = `${authenticatedSessionId}:${message.requestId}`;
      const reattached = dependencies.sessionManager.reattach(managerSessionId, row.id);
      if (reattached) {
        attachChannel(reattached);
        sendStatus('connected');
        const bufferedOutput = dependencies.sessionManager.getBufferedOutput(managerSessionId, row.id);
        if (bufferedOutput && bufferedOutput.length > 0) {
          sendOutput(bufferedOutput);
        }
        dependencies.hostRepository.markConnected(row.id);
        return;
      }

      const knownHostKey = row.hostKeyAlgorithm && row.hostKeyFingerprint
        ? { algorithm: row.hostKeyAlgorithm, fingerprint: row.hostKeyFingerprint }
        : null;
      hostKeyPolicy = new HostKeyPolicy({
        hostId: row.id,
        address: row.address,
        port: row.port,
        knownHostKey,
        saveHostKey: (hostId, algorithm, fingerprint) => {
          dependencies.hostRepository.setHostKey(hostId, algorithm, fingerprint);
        }
      });

      const credential = await dependencies.vaultService.decryptJson<HostCredentialInput>(
        (dependencies.sessionStore.get(authenticatedSessionId) ?? (() => { throw new AppError('SESSION_INVALID'); })()).vaultKey,
        `host:${row.id}:credentials:v1`,
        parseCredentialBlob(row.credentialCiphertext)
      );
      const config: SshConnectConfig = {
        hostId: row.id,
        address: row.address,
        port: row.port,
        username: row.username,
        auth: credential,
        hostKeyAlgorithm: row.hostKeyAlgorithm,
        hostKeyFingerprint: row.hostKeyFingerprint,
        cols: message.cols,
        rows: message.rows,
        term: message.term ?? 'xterm-256color'
      };
      const callbacks: SshConnectCallbacks = {
        onStatus: (state) => sendStatus(state),
        onHostKey: async (challenge) => new Promise<boolean>((resolve) => {
          hostKeyPolicy?.verifyFingerprint(challenge.fingerprint, challenge.algorithm, (accepted) => {
            if (!accepted && hostKeyPolicy?.hasMismatch) {
              send({ type: 'error', code: 'HOST_KEY_MISMATCH', message: '远程主机指纹与已保存指纹不一致' });
            }
            resolve(accepted);
          });
          const pending = hostKeyPolicy?.pendingChallenge;
          if (pending) {
            sendStatus('awaiting-host-key');
            send({ type: 'host-key', ...pending });
          }
        })
      };

      sendStatus('connecting');
      try {
        attachChannel(await dependencies.sessionManager.open(managerSessionId, config, callbacks));
        sendStatus('connected');
        dependencies.hostRepository.markConnected(row.id);
        dependencies.auditRepository.insert({ eventType: 'ssh_connected', hostId: row.id, requestId: message.requestId });
      } catch (error) {
        if (hostKeyPolicy?.hasMismatch) {
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
