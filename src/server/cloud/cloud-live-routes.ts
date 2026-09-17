import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';

import type { CloudApiClient } from '../../shared/cloud/client.js';
import { CloudKeyManager } from '../../shared/cloud/key-manager.js';
import { CloudLiveRelay, type CloudLiveSocketFactory } from '../../shared/cloud/live-client.js';
import { LiveWorkspaceChannel } from '../../shared/cloud/live-session.js';
import { parseLiveFrame, type LiveFrame } from '../../shared/cloud/live-protocol.js';
import { parseRemoteWorkspaceClientMessage, type RemoteWorkspaceServerMessage } from '../../shared/cloud/remote-wire.js';
import { AppError } from '../../shared/errors.js';
import { CLOUD_ACCOUNT_SESSION_COOKIE_NAME } from './cloud-account-routes.js';
import { CloudBrowserSessionStore } from './cloud-session-store.js';
import { createNodeCloudLiveSocketFactory } from './node-cloud-live-socket.js';

export interface CloudLiveRouteClient extends Pick<CloudApiClient, 'getWorkspace' | 'listDevices' | 'listWorkspaceKeys' | 'putWorkspaceKey' | 'listAccountDataKeys' | 'putAccountDataKey'> {}

export interface CloudLiveRouteDependencies {
  enabled: boolean;
  baseUrl: string;
  trustedOrigins: readonly string[];
  client: CloudLiveRouteClient;
  sessions: CloudBrowserSessionStore;
  socketFactory?: CloudLiveSocketFactory;
}

const MAX_LOCAL_FRAME_BYTES = 64 * 1024;
const MAX_PENDING_LOCAL_MESSAGES = 8;
const WORKSPACE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const workspaceIdFromRequest = (request: FastifyRequest): string => {
  const workspaceId = (request.params as { workspaceId?: unknown }).workspaceId;
  if (typeof workspaceId !== 'string' || !WORKSPACE_PATTERN.test(workspaceId)) throw new AppError('PROTOCOL_INVALID_MESSAGE');
  return workspaceId;
};

const cloudSessionId = (request: FastifyRequest): string | null => {
  const value = request.cookies[CLOUD_ACCOUNT_SESSION_COOKIE_NAME];
  return typeof value === 'string' && value.length > 0 ? value : null;
};

const requireCloudSession = (request: FastifyRequest, dependencies: CloudLiveRouteDependencies) => {
  const id = cloudSessionId(request);
  if (!id) throw new AppError('ACCOUNT_SESSION_INVALID');
  const session = dependencies.sessions.get(id);
  if (!session || session.account.trusted === false || !session.deviceKeyPair) throw new AppError('ACCOUNT_SESSION_INVALID');
  return { id, session };
};

const validateOrigin = (request: FastifyRequest, trustedOrigins: readonly string[]): void => {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || !trustedOrigins.includes(origin)) throw new AppError('PROTOCOL_INVALID_MESSAGE', '来源不受信任', 403);
};

const rawBytes = (data: RawData, maxBytes: number): Uint8Array | null => {
  if (Buffer.isBuffer(data)) return data.byteLength <= maxBytes ? new Uint8Array(data) : null;
  if (typeof data === 'string') return Buffer.byteLength(data, 'utf8') <= maxBytes ? new TextEncoder().encode(data) : null;
  if (Array.isArray(data)) {
    let total = 0;
    const chunks: Buffer[] = [];
    for (const chunk of data) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) return null;
      chunks.push(buffer);
    }
    return new Uint8Array(Buffer.concat(chunks, total));
  }
  return data.byteLength <= maxBytes ? new Uint8Array(data) : null;
};

const parseLocalMessage = (data: RawData): ReturnType<typeof parseRemoteWorkspaceClientMessage> => {
  const bytes = rawBytes(data, MAX_LOCAL_FRAME_BYTES);
  if (!bytes) throw new AppError('PROTOCOL_INVALID_MESSAGE');
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError('PROTOCOL_INVALID_MESSAGE');
  }
  try {
    return parseRemoteWorkspaceClientMessage(value);
  } catch {
    throw new AppError('PROTOCOL_INVALID_MESSAGE');
  }
};

const sendLocal = (socket: WebSocket, message: RemoteWorkspaceServerMessage): boolean => {
  if (socket.readyState !== 1) return false;
  const encoded = JSON.stringify(message);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_LOCAL_FRAME_BYTES || socket.bufferedAmount + Buffer.byteLength(encoded, 'utf8') > 256 * 1024) {
    socket.close(1009, 'remote workspace buffer limit');
    return false;
  }
  socket.send(encoded);
  return true;
};

const sendError = (socket: WebSocket, message: string): void => {
  sendLocal(socket, { version: 1, type: 'error', message: message.slice(0, 1_024) || '远程工作区连接失败' });
};

const closeSocket = (socket: WebSocket, code: number, reason: string): void => {
  if (socket.readyState === 0 || socket.readyState === 1) socket.close(code, reason);
};

/**
 * Same-origin BFF bridge for Web. It turns the browser's HttpOnly session into
 * a short-lived cloud viewer connection and never forwards the cloud token or
 * workspace key to JavaScript.
 */
export const registerCloudLiveRoutes = async (
  app: FastifyInstance,
  dependencies: CloudLiveRouteDependencies
): Promise<void> => {
  const socketFactory = dependencies.socketFactory ?? createNodeCloudLiveSocketFactory();

  app.get('/ws/cloud/workspaces/:workspaceId', {
    websocket: true,
    preValidation: async (request: FastifyRequest, reply: FastifyReply) => {
      if (!dependencies.enabled) throw new AppError('CAPABILITY_UNAVAILABLE');
      validateOrigin(request, dependencies.trustedOrigins);
      requireCloudSession(request, dependencies);
      // Keep this validation in the HTTP phase so unauthenticated clients do
      // not reach the websocket handler or allocate key/session objects.
      workspaceIdFromRequest(request);
      void reply;
    }
  }, (socket: WebSocket, request: FastifyRequest) => {
    void openCloudWorkspace(socket, request, dependencies, socketFactory);
  });
};

const openCloudWorkspace = async (
  socket: WebSocket,
  request: FastifyRequest,
  dependencies: CloudLiveRouteDependencies,
  socketFactory: CloudLiveSocketFactory
): Promise<void> => {
  let channel: LiveWorkspaceChannel | null = null;
  let relay: CloudLiveRelay | null = null;
  let keyManager: CloudKeyManager | null = null;
  let removeRelayClose: (() => void) | null = null;
  let cleaned = false;
  let prepared = false;
  const pending: RawData[] = [];

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    if (channel) await channel.close().catch(() => undefined);
    else relay?.close();
    removeRelayClose?.();
    removeRelayClose = null;
    keyManager?.clear();
    channel = null;
    relay = null;
    keyManager = null;
    pending.length = 0;
  };

  const handleMessage = async (data: RawData): Promise<void> => {
    if (cleaned || !channel) return;
    try {
      const message = parseLocalMessage(data);
      if (message.type === 'close') {
        await cleanup();
        closeSocket(socket, 1000, 'remote workspace closed');
        return;
      }
      const frame: LiveFrame = message.type === 'input'
        ? parseLiveFrame({
          protocolVersion: 1,
          type: 'terminal-input',
          workspaceId: workspaceIdFromRequest(request),
          sessionId: message.sessionId,
          participantDeviceId: requireCloudSession(request, dependencies).session.account.deviceId,
          inputId: message.inputId,
          payload: message.payload
        })
        : parseLiveFrame({
          protocolVersion: 1,
          type: 'resync-request',
          workspaceId: workspaceIdFromRequest(request),
          sessionId: message.sessionId,
          afterSequence: message.afterSequence
        });
      await channel.send(frame);
    } catch (error) {
      sendError(socket, error instanceof AppError ? error.message : '远程工作区请求失败');
    }
  };

  socket.on('message', (data: RawData) => {
    if (cleaned) return;
    if (!prepared) {
      if (pending.length >= MAX_PENDING_LOCAL_MESSAGES) {
        closeSocket(socket, 1009, 'too many pending messages');
        return;
      }
      pending.push(data);
      return;
    }
    void handleMessage(data);
  });
  socket.on('close', () => { void cleanup(); });
  socket.on('error', () => { void cleanup(); });

  try {
    const workspaceId = workspaceIdFromRequest(request);
    const { session } = requireCloudSession(request, dependencies);
    const descriptor = await dependencies.client.getWorkspace(session.token, workspaceId);
    if (descriptor.ownerDeviceId === session.account.deviceId) {
      // The owner may have been created before its first relay connection.
      // ensureWorkspaceKey is idempotent and only caches at most eight keys.
    }
    keyManager = new CloudKeyManager(dependencies.client, {
      token: session.token,
      accountId: session.account.accountId,
      deviceId: session.account.deviceId,
      deviceKeyPair: session.deviceKeyPair!
    });
    const material = descriptor.ownerDeviceId === session.account.deviceId
      ? await keyManager.ensureWorkspaceKey(workspaceId)
      : await keyManager.getWorkspaceKey(workspaceId);
    try {
      relay = new CloudLiveRelay({
        baseUrl: dependencies.baseUrl,
        token: session.token,
        workspaceId,
        role: 'viewer',
        socketFactory
      });
      channel = new LiveWorkspaceChannel({
        relay,
        workspaceId,
        localDeviceId: session.account.deviceId,
        ownerDeviceId: descriptor.ownerDeviceId,
        role: 'viewer',
        baseKey: material.key,
        onFrame: (frame) => {
          if (frame.type === 'workspace-snapshot' || frame.type === 'terminal-output') {
            sendLocal(socket, {
              version: 1,
              type: 'state',
              status: 'live',
              ownerDeviceId: descriptor.ownerDeviceId,
              participantCount: 0,
              ownerEpoch: frame.ownerEpoch
            });
          }
          sendLocal(socket, { version: 1, type: 'frame', frame });
        },
        onError: (error) => sendError(socket, error.message)
      });
      removeRelayClose = relay.onClose((event) => {
        if (cleaned) return;
        sendLocal(socket, {
          version: 1,
          type: 'state',
          status: 'offline',
          ownerDeviceId: descriptor.ownerDeviceId,
          participantCount: 0,
          ownerEpoch: channel?.ownerEpoch ?? null
        });
        closeSocket(socket, event.code === 1000 ? 1000 : 1012, 'cloud relay disconnected');
      });
    } finally {
      material.key.fill(0);
      keyManager.clear();
    }
    sendLocal(socket, {
      version: 1,
      type: 'state',
      status: 'connecting',
      ownerDeviceId: descriptor.ownerDeviceId,
      participantCount: 0,
      ownerEpoch: channel.ownerEpoch
    });
    await channel.connect();
    prepared = true;
    for (const message of pending.splice(0)) await handleMessage(message);
  } catch (error) {
    sendError(socket, error instanceof AppError ? error.message : '远程工作区暂时不可用');
    await cleanup();
    closeSocket(socket, error instanceof AppError ? 1008 : 1011, 'remote workspace unavailable');
  }
};
