import { randomUUID } from 'node:crypto';

import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import { z } from 'zod';

import type { AccountSession, DeviceDescriptor } from '../shared/core/models.js';
import { parseCloudDataEnvelope, type CloudDataDomain, type CloudDataEnvelope } from '../shared/cloud/protocol.js';
import { AppError } from '../shared/errors.js';
import type { CloudAuthDeviceInput, CloudAuthResult } from './auth-service.js';
import type { CloudRuntimeConfig } from './config.js';
import { BoundedRelayHub, type RelayPeer, type RelaySubscription } from './relay.js';
import { hashCloudIdempotencyKey, type CloudSnapshotHead, type PutCloudSnapshotInput } from './snapshot-repository.js';
import type { CloudWorkspaceDescriptor } from './workspace-repository.js';

export interface CloudAuthApi {
  register(email: string, password: string, device: CloudAuthDeviceInput): Promise<CloudAuthResult>;
  signIn(email: string, password: string, device: CloudAuthDeviceInput): Promise<CloudAuthResult>;
  authenticate(token: string): Promise<AccountSession | null>;
  signOut(token: string): Promise<void>;
  listDevices(token: string): Promise<readonly DeviceDescriptor[]>;
  revokeDevice(token: string, deviceId: string): Promise<void>;
}

export interface CloudSnapshotApi {
  getHead(domain: CloudDataDomain, resourceId: string): Promise<CloudSnapshotHead | null>;
  getRevision(accountId: string, domain: CloudDataDomain, resourceId: string, revision?: number): Promise<CloudDataEnvelope | null>;
  put(input: PutCloudSnapshotInput): Promise<CloudSnapshotHead>;
}

export interface CloudRelayAuthorization {
  canOwn(accountId: string, deviceId: string, workspaceId: string): Promise<boolean>;
  canView(accountId: string, deviceId: string, workspaceId: string): Promise<boolean>;
}

export interface CloudWorkspaceApi extends CloudRelayAuthorization {
  list(accountId: string): Promise<readonly CloudWorkspaceDescriptor[]>;
}

export interface CloudAppDependencies {
  config: CloudRuntimeConfig;
  auth: CloudAuthApi;
  snapshots: CloudSnapshotApi;
  workspaces?: CloudWorkspaceApi;
  relay?: BoundedRelayHub;
  relayAuthorization?: CloudRelayAuthorization;
}

const authSchema = z.object({
  email: z.string().min(1).max(320),
  password: z.string().min(1).max(4096),
  platform: z.enum(['web', 'desktop', 'android']).default('web'),
  deviceLabel: z.string().min(1).max(128).optional(),
  publicKey: z.string().max(16 * 1024).nullable().optional()
}).strict();

const deviceParamsSchema = z.object({ deviceId: z.string().min(1).max(128) }).strict();
const revisionQuerySchema = z.object({ revision: z.coerce.number().int().min(1).max(1_000_000_000).optional() }).strict();

const bearerToken = (request: FastifyRequest): string | null => {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{43,128})$/u.exec(header);
  return match?.[1] ?? null;
};

const websocketBearerToken = (request: FastifyRequest): string | null => {
  const headerToken = bearerToken(request);
  if (headerToken) return headerToken;
  const protocols = request.headers['sec-websocket-protocol'];
  const values = Array.isArray(protocols) ? protocols : typeof protocols === 'string' ? protocols.split(',') : [];
  for (const raw of values) {
    const match = /^\s*relay-bearer\.([A-Za-z0-9_-]{43,128})\s*$/u.exec(raw);
    if (match) return match[1];
  }
  return null;
};

const requireSession = async (request: FastifyRequest, auth: CloudAuthApi): Promise<{ token: string; session: AccountSession }> => {
  const token = bearerToken(request);
  if (!token) throw new AppError('ACCOUNT_SESSION_INVALID');
  const session = await auth.authenticate(token);
  if (!session) throw new AppError('ACCOUNT_SESSION_INVALID');
  return { token, session };
};

const parseAuthInput = (body: unknown): { email: string; password: string; device: CloudAuthDeviceInput } => {
  const parsed = authSchema.safeParse(body);
  if (!parsed.success) throw new AppError('PROTOCOL_INVALID_MESSAGE');
  return {
    email: parsed.data.email,
    password: parsed.data.password,
    device: {
      platform: parsed.data.platform,
      label: parsed.data.deviceLabel,
      publicKey: parsed.data.publicKey
    }
  };
};

const parseIdempotencyKey = (request: FastifyRequest): string => {
  const value = request.headers['idempotency-key'];
  const key = Array.isArray(value) ? value[0] : value;
  if (typeof key !== 'string' || key.length === 0 || key.length > 256) throw new AppError('SYNC_PAYLOAD_INVALID');
  return key;
};

const asRawBuffer = (data: RawData): Uint8Array => {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data.map((chunk) => Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
  return Buffer.from(data);
};

const relayPeer = (socket: WebSocket): RelayPeer => ({
  get bufferedBytes() {
    return socket.bufferedAmount;
  },
  send(frame) {
    if (socket.readyState === 1) socket.send(frame);
  },
  close(code, reason) {
    if (socket.readyState === 1 || socket.readyState === 0) socket.close(code, reason);
  }
});

const relayWorkspaceId = (request: FastifyRequest): string => {
  const parsed = z.object({ workspaceId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u) }).strict().safeParse(request.query);
  if (!parsed.success) throw new AppError('SYNC_PAYLOAD_INVALID');
  return parsed.data.workspaceId;
};

const requireRelaySession = async (request: FastifyRequest, auth: CloudAuthApi): Promise<{ token: string; session: AccountSession }> => {
  const token = websocketBearerToken(request);
  if (!token) throw new AppError('ACCOUNT_SESSION_INVALID');
  const session = await auth.authenticate(token);
  if (!session) throw new AppError('ACCOUNT_SESSION_INVALID');
  return { token, session };
};

const requireWorkspaceAccess = async (
  session: AccountSession,
  workspaceId: string,
  dependencies: CloudAppDependencies,
  role: 'owner' | 'viewer'
): Promise<void> => {
  const workspaces = dependencies.workspaces;
  const allowed = role === 'owner'
    ? await workspaces?.canOwn(session.accountId, session.deviceId, workspaceId)
    : await workspaces?.canView(session.accountId, session.deviceId, workspaceId);
  if (!allowed) throw new AppError('ACCOUNT_DEVICE_REVOKED');
};

const parseSnapshot = (body: unknown): CloudDataEnvelope => {
  try {
    return parseCloudDataEnvelope(body);
  } catch {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
};

export const buildCloudApp = async (dependencies: CloudAppDependencies): Promise<FastifyInstance> => {
  const app = Fastify({
    bodyLimit: dependencies.config.relay.maxPayloadBytes,
    genReqId: () => `cloud_${randomUUID()}`,
    logger: { level: dependencies.config.nodeEnv === 'test' ? 'silent' : 'info' }
  });

  await app.register(rateLimit, {
    global: true,
    max: 120,
    timeWindow: '1 minute'
  });
  const relay = dependencies.relay ?? new BoundedRelayHub(dependencies.config.relay);
  await app.register(websocket, { options: { maxPayload: dependencies.config.relay.maxFrameBytes } });

  app.addHook('onRequest', async (request) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) || !request.headers.origin || dependencies.config.trustedOrigins.length === 0) return;
    if (!dependencies.config.trustedOrigins.includes(request.headers.origin)) {
      throw new AppError('PROTOCOL_INVALID_MESSAGE', '来源不受信任', 403);
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      reply.status(error.statusCode).send({ error: { code: error.code, message: error.message, requestId: request.id } });
      return;
    }
    request.log.error({ err: { name: error instanceof Error ? error.name : 'UnknownError', code: 'INTERNAL_ERROR' } }, 'cloud request failed');
    reply.status(500).send({ error: { code: 'INTERNAL_ERROR', message: '服务暂时不可用', requestId: request.id } });
  });

  app.get('/healthz', async () => ({ status: 'ok' }));

  app.post('/v2/auth/register', async (request, reply) => {
    const input = parseAuthInput(request.body);
    const result = await dependencies.auth.register(input.email, input.password, input.device);
    reply.header('cache-control', 'no-store').code(201).send(result);
  });

  app.post('/v2/auth/login', async (request, reply) => {
    const input = parseAuthInput(request.body);
    const result = await dependencies.auth.signIn(input.email, input.password, input.device);
    reply.header('cache-control', 'no-store').send(result);
  });

  app.post('/v2/auth/logout', async (request, reply) => {
    const { token } = await requireSession(request, dependencies.auth);
    await dependencies.auth.signOut(token);
    reply.code(204).send();
  });

  app.get('/v2/devices', async (request, reply) => {
    const { token } = await requireSession(request, dependencies.auth);
    reply.send(await dependencies.auth.listDevices(token));
  });

  app.delete('/v2/devices/:deviceId', async (request, reply) => {
    const { token } = await requireSession(request, dependencies.auth);
    const parsed = deviceParamsSchema.safeParse(request.params);
    if (!parsed.success) throw new AppError('ACCOUNT_DEVICE_REVOKED');
    await dependencies.auth.revokeDevice(token, parsed.data.deviceId);
    reply.code(204).send();
  });

  app.get('/v2/workspaces', async (request, reply) => {
    const { session } = await requireSession(request, dependencies.auth);
    reply.send(dependencies.workspaces ? await dependencies.workspaces.list(session.accountId) : []);
  });

  app.get('/v2/account-data/head', async (request, reply) => {
    const { session } = await requireSession(request, dependencies.auth);
    reply.send(await dependencies.snapshots.getHead('account-data', session.accountId));
  });

  app.get('/v2/account-data/snapshot', async (request, reply) => {
    const { session } = await requireSession(request, dependencies.auth);
    const parsed = revisionQuerySchema.safeParse(request.query);
    if (!parsed.success) throw new AppError('SYNC_PAYLOAD_INVALID');
    const snapshot = await dependencies.snapshots.getRevision(session.accountId, 'account-data', session.accountId, parsed.data.revision);
    if (!snapshot) throw new AppError('SYNC_NOT_FOUND');
    reply.header('cache-control', 'no-store').send(snapshot);
  });

  app.put('/v2/account-data/snapshot', async (request, reply) => {
    const { session } = await requireSession(request, dependencies.auth);
    const snapshot = parseSnapshot(request.body);
    if (snapshot.domain !== 'account-data' || snapshot.accountId !== session.accountId) throw new AppError('SYNC_PAYLOAD_INVALID');
    if (snapshot.writerDeviceId !== session.deviceId) throw new AppError('ACCOUNT_DEVICE_REVOKED');
    const result = await dependencies.snapshots.put({
      accountId: session.accountId,
      writerDeviceId: session.deviceId,
      envelope: snapshot,
      idempotencyKeyHash: hashCloudIdempotencyKey(parseIdempotencyKey(request)),
      now: new Date().toISOString()
    });
    reply.send(result);
  });

  app.get('/v2/workspaces/:workspaceId/head', async (request, reply) => {
    const { session } = await requireSession(request, dependencies.auth);
    const workspaceId = typeof (request.params as { workspaceId?: unknown }).workspaceId === 'string'
      ? (request.params as { workspaceId: string }).workspaceId
      : '';
    if (!workspaceId) throw new AppError('SYNC_PAYLOAD_INVALID');
    await requireWorkspaceAccess(session, workspaceId, dependencies, 'viewer');
    reply.send(await dependencies.snapshots.getHead('workspace', workspaceId));
  });

  app.get('/v2/workspaces/:workspaceId/snapshot', async (request, reply) => {
    const { session } = await requireSession(request, dependencies.auth);
    const workspaceId = typeof (request.params as { workspaceId?: unknown }).workspaceId === 'string'
      ? (request.params as { workspaceId: string }).workspaceId
      : '';
    const parsed = revisionQuerySchema.safeParse(request.query);
    if (!workspaceId || !parsed.success) throw new AppError('SYNC_PAYLOAD_INVALID');
    await requireWorkspaceAccess(session, workspaceId, dependencies, 'viewer');
    const snapshot = await dependencies.snapshots.getRevision(session.accountId, 'workspace', workspaceId, parsed.data.revision);
    if (!snapshot) throw new AppError('SYNC_NOT_FOUND');
    reply.header('cache-control', 'no-store').send(snapshot);
  });

  app.put('/v2/workspaces/:workspaceId/snapshot', async (request, reply) => {
    const { session } = await requireSession(request, dependencies.auth);
    const snapshot = parseSnapshot(request.body);
    const workspaceId = typeof (request.params as { workspaceId?: unknown }).workspaceId === 'string'
      ? (request.params as { workspaceId: string }).workspaceId
      : '';
    if (!workspaceId || snapshot.domain !== 'workspace' || snapshot.accountId !== session.accountId || snapshot.workspaceId !== workspaceId) {
      throw new AppError('SYNC_PAYLOAD_INVALID');
    }
    await requireWorkspaceAccess(session, workspaceId, dependencies, 'owner');
    if (snapshot.writerDeviceId !== session.deviceId) throw new AppError('ACCOUNT_DEVICE_REVOKED');
    const result = await dependencies.snapshots.put({
      accountId: session.accountId,
      workspaceId,
      writerDeviceId: session.deviceId,
      envelope: snapshot,
      idempotencyKeyHash: hashCloudIdempotencyKey(parseIdempotencyKey(request)),
      now: new Date().toISOString()
    });
    reply.send(result);
  });

  const relayHandshake = async (request: FastifyRequest, role: 'owner' | 'viewer'): Promise<void> => {
    const workspaceId = relayWorkspaceId(request);
    const { session } = await requireRelaySession(request, dependencies.auth);
    const authorization = dependencies.relayAuthorization ?? dependencies.workspaces;
    const allowed = role === 'owner'
      ? await authorization?.canOwn(session.accountId, session.deviceId, workspaceId)
      : await authorization?.canView(session.accountId, session.deviceId, workspaceId);
    if (!allowed) throw new AppError('ACCOUNT_DEVICE_REVOKED');
  };

  const openRelay = async (socket: WebSocket, request: FastifyRequest, role: 'owner' | 'viewer'): Promise<void> => {
    const workspaceId = relayWorkspaceId(request);
    const { session } = await requireRelaySession(request, dependencies.auth);
    const authorization = dependencies.relayAuthorization ?? dependencies.workspaces;
    if (!authorization) {
      socket.close(1008, 'relay authorization unavailable');
      return;
    }
    const allowed = role === 'owner'
      ? await authorization.canOwn(session.accountId, session.deviceId, workspaceId)
      : await authorization.canView(session.accountId, session.deviceId, workspaceId);
    if (!allowed) {
      socket.close(1008, 'relay access denied');
      return;
    }

    let subscription: RelaySubscription;
    try {
      subscription = role === 'owner'
        ? relay.registerOwner(workspaceId, session.deviceId, relayPeer(socket))
        : relay.subscribeViewer(workspaceId, session.deviceId, relayPeer(socket));
    } catch {
      socket.close(1013, 'relay unavailable');
      return;
    }
    const close = (): void => subscription.close();
    socket.on('close', close);
    socket.on('error', close);
    socket.on('message', (data: RawData) => {
      const frame = asRawBuffer(data);
      if (role === 'owner') {
        if (relay.forwardFromOwner(workspaceId, frame) === 0 && frame.byteLength > dependencies.config.relay.maxFrameBytes) {
          socket.close(1009, 'frame too large');
        }
      } else if (!relay.forwardFromViewer(workspaceId, session.deviceId, frame) && frame.byteLength > dependencies.config.relay.maxFrameBytes) {
        socket.close(1009, 'frame too large');
      }
    });
  };

  app.get('/v2/relay/owner', {
    websocket: true,
    preValidation: async (request) => relayHandshake(request, 'owner')
  }, (socket: WebSocket, request: FastifyRequest) => {
    void openRelay(socket, request, 'owner');
  });

  app.get('/v2/relay/viewer', {
    websocket: true,
    preValidation: async (request) => relayHandshake(request, 'viewer')
  }, (socket: WebSocket, request: FastifyRequest) => {
    void openRelay(socket, request, 'viewer');
  });

  return app;
};
