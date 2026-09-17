import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/server/app.js';
import type { CloudLiveSocket } from '../../../src/shared/cloud/live-client.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';

const ORIGIN = 'http://localhost:4173';
const ACCOUNT = {
  accountId: 'account-1',
  deviceId: 'device-1',
  state: 'signed-in' as const,
  expiresAt: '2026-10-18T00:00:00.000Z',
  trusted: true
};
const WORKSPACE = {
  id: 'workspace-1',
  accountId: ACCOUNT.accountId,
  ownerDeviceId: ACCOUNT.deviceId,
  encryptedTitle: 'opaque',
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z',
  deletedAt: null
};

class FakeCloudSocket implements CloudLiveSocket {
  readyState = 0;
  bufferedAmount = 0;
  binaryType?: string;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  readonly sent: Uint8Array[] = [];

  send(data: Uint8Array): void { this.sent.push(new Uint8Array(data)); }
  close(code = 1000, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
}

const cookieFrom = (response: { headers: Record<string, string | string[] | undefined> }): string => {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('cloud cookie missing');
  return value.split(';', 1)[0];
};

const connectSocket = (url: string, cookie: string, origin = ORIGIN): Promise<WebSocket> => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${url}/ws/cloud/workspaces/workspace-1`, { headers: { Cookie: cookie, Origin: origin } });
  ensureReader(socket);
  socket.once('open', () => resolve(socket));
  socket.once('unexpected-response', (_request, response) => reject(Object.assign(new Error('websocket rejected'), { statusCode: response.statusCode })));
  socket.once('error', reject);
});

interface MessageReader {
  queue: Array<string | Buffer>;
  waiters: Array<{ resolve: (message: string | Buffer) => void; reject: (error: Error) => void }>;
}

const readers = new WeakMap<WebSocket, MessageReader>();

const ensureReader = (socket: WebSocket): MessageReader => {
  let reader = readers.get(socket);
  if (reader) return reader;
  reader = { queue: [], waiters: [] };
  readers.set(socket, reader);
  socket.on('message', (data: WebSocket.RawData) => {
    const message = Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array);
    const waiter = reader?.waiters.shift();
    if (waiter) waiter.resolve(message);
    else reader?.queue.push(message);
  });
  socket.on('error', (error: Error) => {
    const waiters = reader?.waiters.splice(0) ?? [];
    for (const waiter of waiters) waiter.reject(error);
  });
  return reader;
};

const nextJson = <T>(socket: WebSocket): Promise<T> => {
  const reader = ensureReader(socket);
  if (reader.queue.length > 0) return Promise.resolve(JSON.parse((reader.queue.shift() as Buffer).toString('utf8')) as T);
  return new Promise((resolve, reject) => reader?.waiters.push({
    resolve: (message) => resolve(JSON.parse(message.toString()) as T),
    reject
  }));
};

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(predicate()).toBe(true);
};

const makeCloudClient = (cloudSocket: { current: FakeCloudSocket | null }) => {
  let publicKey: string | null = null;
  return {
    async register(_email: string, _password: string, device: { publicKey?: string | null }) {
      publicKey = device.publicKey ?? null;
      return { account: ACCOUNT, token: 'a'.repeat(43) };
    },
    async signIn(_email: string, _password: string, device: { publicKey?: string | null }) {
      publicKey = device.publicKey ?? null;
      return { account: ACCOUNT, token: 'b'.repeat(43) };
    },
    async getSession() { return { account: ACCOUNT }; },
    async refresh() { return { account: ACCOUNT, token: 'c'.repeat(43) }; },
    async signOut() {},
    async listDevices() { return [{ id: ACCOUNT.deviceId, label: 'Browser', platform: 'web' as const, lastSeenAt: null, current: true, revokedAt: null, trustedAt: '2026-09-18T00:00:00.000Z', publicKey }]; },
    async revokeDevice() {},
    async trustDevice() {},
    async listWorkspaces() { return [WORKSPACE]; },
    async getWorkspace() { return WORKSPACE; },
    async listWorkspaceKeys() { return []; },
    async putWorkspaceKey(_token: string, workspaceId: string, recipientDeviceId: string, input: { keyVersion: number; wrappedKey: Record<string, unknown> }) {
      return { protocolVersion: 1 as const, domain: 'workspace' as const, accountId: ACCOUNT.accountId, resourceId: workspaceId, recipientDeviceId, keyVersion: input.keyVersion, wrappedKey: input.wrappedKey, createdAt: '2026-09-18T00:00:00.000Z', revokedAt: null };
    },
    get cloudSocketFactory() {
      return (url: string, protocols: readonly string[]) => {
        void url;
        void protocols;
        const socket = new FakeCloudSocket();
        cloudSocket.current = socket;
        return socket;
      };
    }
  };
};

describe('cloud live workspace BFF bridge', () => {
  const databases: ReturnType<typeof openDatabase>[] = [];
  const apps: Array<{ listen: (options: { port: number; host: string }) => Promise<string>; close: () => Promise<unknown> }> = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    for (const database of databases.splice(0)) database.close();
  });

  it('keeps cloud credentials server-side and opens a bounded local viewer bridge', async () => {
    const database = openDatabase(':memory:');
    migrate(database);
    databases.push(database);
    const cloudSocket: { current: FakeCloudSocket | null } = { current: null };
    const cloudClient = makeCloudClient(cloudSocket);
    const app = await buildApp({
      database,
      cloudApiClient: cloudClient,
      cloudLiveSocketFactory: cloudClient.cloudSocketFactory,
      config: {
        nodeEnv: 'test',
        port: 3000,
        dataDir: ':memory:',
        trustedOrigins: [ORIGIN],
        sessionIdleTimeoutMs: 60_000,
        maxSessions: 4,
        cloudApiUrl: 'http://cloud.test',
        logLevel: 'silent'
      }
    });
    apps.push(app);

    const signedIn = await app.inject({ method: 'POST', url: '/api/cloud/account/session', payload: { email: 'user@example.com', password: 'long enough password' } });
    const cookie = cookieFrom(signedIn);
    expect(signedIn.body).not.toContain('b'.repeat(43));
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    const socket = await connectSocket(address.replace(/^http/u, 'ws'), cookie);
    await waitFor(() => cloudSocket.current !== null);
    expect(await nextJson<{ type: string; status: string }>(socket)).toEqual(expect.objectContaining({ type: 'state', status: 'connecting' }));
    cloudSocket.current?.open();
    await waitFor(() => (cloudSocket.current?.sent.length ?? 0) > 0);
    socket.close();
  });

  it('rejects an untrusted browser origin before allocating a cloud relay', async () => {
    const database = openDatabase(':memory:');
    migrate(database);
    databases.push(database);
    const cloudSocket: { current: FakeCloudSocket | null } = { current: null };
    const cloudClient = makeCloudClient(cloudSocket);
    const app = await buildApp({
      database,
      cloudApiClient: cloudClient,
      cloudLiveSocketFactory: cloudClient.cloudSocketFactory,
      config: { nodeEnv: 'test', port: 3000, dataDir: ':memory:', trustedOrigins: [ORIGIN], sessionIdleTimeoutMs: 60_000, maxSessions: 4, cloudApiUrl: 'http://cloud.test', logLevel: 'silent' }
    });
    apps.push(app);
    const signedIn = await app.inject({ method: 'POST', url: '/api/cloud/account/session', payload: { email: 'user@example.com', password: 'long enough password' } });
    await expect(connectSocket((await app.listen({ port: 0, host: '127.0.0.1' })).replace(/^http/u, 'ws'), cookieFrom(signedIn), 'https://evil.example')).rejects.toMatchObject({ statusCode: 403 });
    expect(cloudSocket.current).toBeNull();
  });
});
