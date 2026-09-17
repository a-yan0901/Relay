import { EventEmitter } from 'node:events';

import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/server/app.js';
import { AppError } from '../../../src/shared/errors.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';
import { SshSessionManager } from '../../../src/server/ssh/session-manager.js';
import type {
  SshAdapterPort,
  SshChannel,
  SshConnectCallbacks,
  SshConnectConfig
} from '../../../src/server/ssh/types.js';

const MASTER_PASSWORD = 'correct horse battery staple';
const ORIGIN = 'http://localhost:4173';
const databases: ReturnType<typeof openDatabase>[] = [];
const apps: Array<{ close: () => Promise<unknown>; listen: (options: { port: number; host: string }) => Promise<string>; server: { address: () => string | { port: number } | null } }> = [];

class FakeChannel extends EventEmitter implements SshChannel {
  readonly writes: Array<string | Buffer> = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  closeCalls = 0;

  write(data: string | Buffer): void { this.writes.push(data); }
  resize(cols: number, rows: number): void { this.resizes.push({ cols, rows }); }
  close(): void {
    this.closeCalls += 1;
    this.emit('close');
  }
}

class ChallengeAdapter implements SshAdapterPort {
  readonly channels: FakeChannel[] = [];
  readonly configs: SshConnectConfig[] = [];
  challengeAlgorithm = 'ssh-ed25519';
  challengeFingerprint = 'SHA256:fixture-key';

  async connect(config: SshConnectConfig, callbacks: SshConnectCallbacks): Promise<SshChannel> {
    this.configs.push(config);
    const challenge = {
      algorithm: this.challengeAlgorithm,
      fingerprint: this.challengeFingerprint,
      address: config.address,
      port: config.port
    };
    const accepted = await callbacks.onHostKey(challenge);
    if (!accepted) {
      throw new AppError('HOST_KEY_MISMATCH');
    }
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }

  async testConnection(): Promise<{ ok: boolean }> { return { ok: true }; }
}

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

const cookieFrom = (response: { headers: Record<string, string | string[] | undefined> }): string => {
  const header = response.headers['set-cookie'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) throw new Error('expected session cookie');
  return value.split(';', 1)[0];
};

const makeApp = async (serviceInstanceId = 'service-test') => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
  const adapter = new ChallengeAdapter();
  const manager = new SshSessionManager({ adapter, maxSessions: 4, detachGraceMs: 30_000 });
  const app = await buildApp({
    database,
    sshSessionManager: manager,
    serviceInstanceId,
    config: {
      nodeEnv: 'test',
      port: 3000,
      dataDir: ':memory:',
      trustedOrigins: [ORIGIN],
      sessionIdleTimeoutMs: 60_000,
      maxSessions: 4,
      logLevel: 'silent'
    }
  });
  apps.push(app);
  return { app, adapter };
};

const listen = async (app: Awaited<ReturnType<typeof buildApp>>): Promise<string> => {
  const address = await app.listen({ port: 0, host: '127.0.0.1' });
  return address.replace(/^http/u, 'ws');
};

const connectSocket = (url: string, options: { cookie?: string; origin?: string } = {}): Promise<WebSocket> => new Promise((resolve, reject) => {
  const socket = new WebSocket(`${url}/ws/terminal`, {
    headers: {
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.origin ? { Origin: options.origin } : {})
    }
  });
  socket.once('open', () => resolve(socket));
  socket.once('unexpected-response', (_request, response) => {
    reject(Object.assign(new Error('websocket rejected'), { statusCode: response.statusCode }));
  });
  socket.once('error', reject);
});

interface MessageReader {
  queue: Array<string | Buffer>;
  waiters: Array<{ resolve: (message: string | Buffer) => void; reject: (error: Error) => void }>;
}

const messageReaders = new WeakMap<WebSocket, MessageReader>();

const nextMessage = (socket: WebSocket): Promise<string | Buffer> => {
  let reader = messageReaders.get(socket);
  if (!reader) {
    reader = { queue: [], waiters: [] };
    messageReaders.set(socket, reader);
    socket.on('message', (data: WebSocket.RawData) => {
      const message = Buffer.isBuffer(data) ? data : data.toString();
      const waiter = reader?.waiters.shift();
      if (waiter) {
        waiter.resolve(message);
      } else {
        reader?.queue.push(message);
      }
    });
    socket.on('error', (error: Error) => {
      const waiters = reader?.waiters.splice(0) ?? [];
      for (const waiter of waiters) waiter.reject(error);
    });
  }

  if (reader.queue.length > 0) {
    return Promise.resolve(reader.queue.shift() as string | Buffer);
  }
  return new Promise((resolve, reject) => reader?.waiters.push({ resolve, reject }));
};

const nextJson = async <T>(socket: WebSocket): Promise<T> => {
  const message = await nextMessage(socket);
  return JSON.parse(Buffer.isBuffer(message) ? message.toString('utf8') : message) as T;
};

const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(predicate()).toBe(true);
};

const multipart = (filename: string, content: string): { body: Buffer; contentType: string } => {
  const boundary = '----terminal-credential-test-boundary';
  const body = Buffer.from([
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`,
    content,
    `\r\n--${boundary}--\r\n`
  ].join(''), 'utf8');
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
};

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const database of databases.splice(0)) database.close();
});

describe('terminal WebSocket gateway', () => {
  it('rejects missing sessions and untrusted origins before accepting the socket', async () => {
    const { app } = await makeApp();
    const url = await listen(app);

    await expect(connectSocket(url, { origin: ORIGIN })).rejects.toMatchObject({ statusCode: 401 });

    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const cookie = cookieFrom(setup);
    await expect(connectSocket(url, { cookie, origin: 'https://evil.example' })).rejects.toMatchObject({ statusCode: 403 });
  });

  it('opens a real terminal session, handles host-key trust, binary I/O, resize, and close', async () => {
    const { app, adapter } = await makeApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const cookie = cookieFrom(setup);
    const created = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: {
        name: 'Fixture SSH',
        address: 'ssh-fixture',
        username: 'fixture',
        auth: { type: 'password', password: 'fixture-password' }
      }
    });
    const hostId = json<{ id: string }>(created).id;
    const url = await listen(app);
    const socket = await connectSocket(url, { cookie, origin: ORIGIN });
    const statuses: string[] = [];
    socket.send(JSON.stringify({ type: 'open', hostId, cols: 120, rows: 36, requestId: 'tab-1' }));

    const first = await nextJson<{ type: string; state?: string; serviceInstanceId?: string; fingerprint?: string }>(socket);
    if (first.type === 'status' && first.state === 'connecting') statuses.push(first.state);
    expect(first.serviceInstanceId).toBe('service-test');
    const awaiting = await nextJson<{ type: string; state?: string }>(socket);
    expect(awaiting).toEqual(expect.objectContaining({ type: 'status', state: 'awaiting-host-key', serviceInstanceId: 'service-test' }));
    const challenge = await nextJson<{ type: string; fingerprint: string }>(socket);
    expect(challenge).toEqual(expect.objectContaining({ type: 'host-key', fingerprint: 'SHA256:fixture-key' }));
    socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }));
    socket.send(JSON.stringify({ type: 'host-key-decision', decision: 'trust', fingerprint: 'SHA256:fixture-key' }));

    const connected = await nextJson<{ type: string; state?: string }>(socket);
    expect(connected).toEqual(expect.objectContaining({ type: 'status', state: 'connected' }));
    expect(statuses).toEqual(['connecting']);
    const listedHosts = await app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie } });
    expect(json<Array<{ id: string; lastConnectedAt: string | null }>>(listedHosts)).toEqual([
      expect.objectContaining({ id: hostId, lastConnectedAt: expect.any(String) })
    ]);

    const channel = adapter.channels[0];
    expect(channel.resizes).toEqual([{ cols: 100, rows: 30 }]);
    channel.emit('data', Buffer.from('fixture output'));
    expect((await nextMessage(socket)).toString()).toBe('fixture output');
    socket.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    socket.send(Buffer.from('printf gateway\\n'));
    await waitFor(() => channel.resizes.length === 2 && channel.writes.length === 1);
    expect(channel.resizes).toEqual([{ cols: 100, rows: 30 }, { cols: 80, rows: 24 }]);
    expect(channel.writes[0].toString()).toBe('printf gateway\\n');

    const staleSocket = await connectSocket(url, { cookie, origin: ORIGIN });
    staleSocket.send(JSON.stringify({ type: 'open', hostId, cols: 80, rows: 24, requestId: 'tab-stale', knownServiceInstanceId: 'service-before-restart' }));
    expect(await nextJson<{ type: string; code?: string }>(staleSocket)).toEqual(expect.objectContaining({ type: 'error', code: 'SESSION_NEEDS_REOPEN' }));
    staleSocket.close();

    socket.send(JSON.stringify({ type: 'close' }));
    expect((await nextJson<{ type: string; state?: string }>(socket)).state).toBe('closed');
    expect(channel.closeCalls).toBe(1);
    socket.close();
  });

  it('reports an unexpected channel reset as retryable and creates a new shell after reopen', async () => {
    const { app, adapter } = await makeApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const cookie = cookieFrom(setup);
    const created = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: {
        name: 'Resettable SSH',
        address: 'ssh-fixture',
        username: 'fixture',
        auth: { type: 'password', password: 'fixture-password' }
      }
    });
    const hostId = json<{ id: string }>(created).id;
    const url = await listen(app);
    const socket = await connectSocket(url, { cookie, origin: ORIGIN });
    const requestId = 'tab-reset';
    socket.send(JSON.stringify({ type: 'open', hostId, cols: 120, rows: 36, requestId }));
    expect(await nextJson<{ type: string; state?: string }>(socket)).toEqual(expect.objectContaining({ type: 'status', state: 'connecting' }));
    expect(await nextJson<{ type: string; state?: string }>(socket)).toEqual(expect.objectContaining({ type: 'status', state: 'awaiting-host-key' }));
    expect(await nextJson<{ type: string; fingerprint: string }>(socket)).toEqual(expect.objectContaining({ type: 'host-key', fingerprint: 'SHA256:fixture-key' }));
    socket.send(JSON.stringify({ type: 'host-key-decision', decision: 'trust', fingerprint: 'SHA256:fixture-key' }));
    expect(await nextJson<{ type: string; state?: string }>(socket)).toEqual(expect.objectContaining({ type: 'status', state: 'connected' }));

    const channel = adapter.channels[0];
    channel.emit('error', new Error('remote reset'));
    channel.emit('close');
    const resetEvents = [await nextJson<{ type: string; state?: string; code?: string }>(socket), await nextJson<{ type: string; state?: string; code?: string }>(socket)];
    expect(resetEvents.filter((event) => event.type === 'error' && event.code === 'SSH_CONNECTION_FAILED')).toHaveLength(1);
    expect(resetEvents.some((event) => event.type === 'status' && event.state === 'interrupted')).toBe(true);

    socket.close();
    const reopened = await connectSocket(url, { cookie, origin: ORIGIN });
    reopened.send(JSON.stringify({ type: 'open', hostId, cols: 120, rows: 36, requestId }));
    expect(await nextJson<{ type: string; state?: string }>(reopened)).toEqual(expect.objectContaining({ type: 'status', state: 'connecting' }));
    expect(await nextJson<{ type: string; state?: string }>(reopened)).toEqual(expect.objectContaining({ type: 'status', state: 'connected' }));
    expect(adapter.channels).toHaveLength(2);

    reopened.send(JSON.stringify({ type: 'close' }));
    expect(await nextJson<{ type: string; state?: string }>(reopened)).toEqual(expect.objectContaining({ type: 'status', state: 'closed' }));
    reopened.close();
  });

  it('shows old and new Host Key fingerprints before allowing an explicit replacement', async () => {
    const { app, adapter } = await makeApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const cookie = cookieFrom(setup);
    const created = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: { name: 'Rotating Host Key', address: 'ssh-fixture', username: 'fixture', auth: { type: 'password', password: 'fixture-password' } }
    });
    const hostId = json<{ id: string }>(created).id;
    const url = await listen(app);

    const firstSocket = await connectSocket(url, { cookie, origin: ORIGIN });
    firstSocket.send(JSON.stringify({ type: 'open', hostId, cols: 120, rows: 36, requestId: 'rotate-first' }));
    await nextJson(firstSocket);
    await nextJson(firstSocket);
    await nextJson(firstSocket);
    firstSocket.send(JSON.stringify({ type: 'host-key-decision', decision: 'trust', fingerprint: 'SHA256:fixture-key' }));
    await nextJson(firstSocket);
    firstSocket.send(JSON.stringify({ type: 'close' }));
    await nextJson(firstSocket);
    firstSocket.close();

    adapter.challengeFingerprint = 'SHA256:replacement-key';
    const secondSocket = await connectSocket(url, { cookie, origin: ORIGIN });
    secondSocket.send(JSON.stringify({ type: 'open', hostId, cols: 120, rows: 36, requestId: 'rotate-second' }));
    await nextJson(secondSocket);
    await nextJson(secondSocket);
    const changed = await nextJson<{
      type: string;
      reason?: string;
      algorithm: string;
      fingerprint: string;
      previous?: { algorithm: string; fingerprint: string };
    }>(secondSocket);
    expect(changed).toEqual(expect.objectContaining({
      type: 'host-key',
      reason: 'changed',
      algorithm: 'ssh-ed25519',
      fingerprint: 'SHA256:replacement-key',
      previous: { algorithm: 'ssh-ed25519', fingerprint: 'SHA256:fixture-key' }
    }));
    secondSocket.send(JSON.stringify({ type: 'host-key-decision', decision: 'trust', fingerprint: 'SHA256:replacement-key' }));
    expect(await nextJson<{ type: string; state?: string }>(secondSocket)).toEqual(expect.objectContaining({ type: 'status', state: 'connected' }));

    const listedHosts = await app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie } });
    expect(json<Array<{ hostKeyFingerprint: string | null }>>(listedHosts)[0]?.hostKeyFingerprint).toBe('SHA256:replacement-key');
    secondSocket.send(JSON.stringify({ type: 'close' }));
    await nextJson(secondSocket);
    secondSocket.close();
  });

  it('persists a missing imported password after a successful connection', async () => {
    const { app, adapter } = await makeApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const cookie = cookieFrom(setup);
    const upload = multipart('connections.csv', 'name,host,user,password\nImported SSH,ssh-fixture,fixture,\n');
    const previewResponse = await app.inject({ method: 'POST', url: '/api/import/preview', headers: { cookie, 'content-type': upload.contentType }, payload: upload.body });
    const preview = json<{ previewId: string; connections: Array<{ sourceId: string }> }>(previewResponse);
    const applied = await app.inject({ method: 'POST', url: '/api/import/apply', headers: { cookie }, payload: {
      previewId: preview.previewId,
      selectedSourceIds: [preview.connections[0].sourceId],
      conflictPolicy: 'create'
    } });
    expect(applied.statusCode).toBe(200);
    const hosts = json<Array<{ id: string }>>(await app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie } }));
    const hostId = hosts[0]?.id;
    expect(hostId).toBeTruthy();

    const url = await listen(app);
    const socket = await connectSocket(url, { cookie, origin: ORIGIN });
    socket.send(JSON.stringify({ type: 'open', hostId, cols: 120, rows: 36, requestId: 'tab-missing-credential' }));
    expect(await nextJson<{ type: string; state?: string }>(socket)).toEqual(expect.objectContaining({ type: 'status', state: 'awaiting-credential' }));
    expect(await nextJson<{ type: string; hostId: string; authType: string }>(socket)).toEqual(expect.objectContaining({ type: 'credential-required', hostId, authType: 'password' }));

    socket.send(JSON.stringify({ type: 'credential', hostId, credential: { type: 'password', password: 'filled-at-connect' } }));
    const connecting = await nextJson<{ type: string; state?: string }>(socket);
    expect(connecting).toEqual(expect.objectContaining({ type: 'status', state: 'connecting' }));
    expect(await nextJson<{ type: string; state?: string }>(socket)).toEqual(expect.objectContaining({ type: 'status', state: 'awaiting-host-key' }));
    expect(await nextJson<{ type: string; fingerprint: string }>(socket)).toEqual(expect.objectContaining({ type: 'host-key', fingerprint: 'SHA256:fixture-key' }));
    socket.send(JSON.stringify({ type: 'host-key-decision', decision: 'trust', fingerprint: 'SHA256:fixture-key' }));
    expect(await nextJson<{ type: string; state?: string }>(socket)).toEqual(expect.objectContaining({ type: 'status', state: 'connected' }));
    expect(adapter.configs[0]?.auth).toEqual({ type: 'password', password: 'filled-at-connect' });

    socket.send(JSON.stringify({ type: 'close' }));
    expect(await nextJson<{ type: string; state?: string }>(socket)).toEqual(expect.objectContaining({ type: 'status', state: 'closed' }));
    socket.close();

    const secondSocket = await connectSocket(url, { cookie, origin: ORIGIN });
    secondSocket.send(JSON.stringify({ type: 'open', hostId, cols: 120, rows: 36, requestId: 'tab-missing-credential-retry' }));
    expect(await nextJson<{ type: string; state?: string }>(secondSocket)).toEqual(expect.objectContaining({ type: 'status', state: 'connecting' }));
    expect(await nextJson<{ type: string; state?: string }>(secondSocket)).toEqual(expect.objectContaining({ type: 'status', state: 'connected' }));
    expect(adapter.configs[1]?.auth).toEqual({ type: 'password', password: 'filled-at-connect' });
    secondSocket.close();
  });

  it('replays buffered output when a refreshed browser reattaches the terminal session', async () => {
    const { app, adapter } = await makeApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const cookie = cookieFrom(setup);
    const created = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: {
        name: 'Fixture SSH',
        address: 'ssh-fixture',
        username: 'fixture',
        auth: { type: 'password', password: 'fixture-password' }
      }
    });
    const hostId = json<{ id: string }>(created).id;
    const url = await listen(app);
    const firstSocket = await connectSocket(url, { cookie, origin: ORIGIN });
    firstSocket.send(JSON.stringify({ type: 'open', hostId, cols: 120, rows: 36, requestId: 'tab-refresh' }));
    const firstStatus = await nextJson<{ type: string; state?: string }>(firstSocket);
    if (firstStatus.state === 'connecting') {
      expect(await nextJson<{ type: string; state?: string; serviceInstanceId?: string }>(firstSocket)).toEqual({ type: 'status', state: 'awaiting-host-key', serviceInstanceId: 'service-test' });
    }
    const challenge = await nextJson<{ type: string; fingerprint: string }>(firstSocket);
    expect(challenge).toEqual(expect.objectContaining({ type: 'host-key', fingerprint: 'SHA256:fixture-key' }));
    firstSocket.send(JSON.stringify({ type: 'host-key-decision', decision: 'trust', fingerprint: 'SHA256:fixture-key' }));
    await nextJson(firstSocket);

    const channel = adapter.channels[0];
    channel.emit('data', Buffer.from('output before refresh\n'));
    expect((await nextMessage(firstSocket)).toString()).toBe('output before refresh\n');

    const firstSocketClosed = new Promise<void>((resolve) => firstSocket.once('close', () => resolve()));
    firstSocket.close();
    await firstSocketClosed;

    const refreshedSocket = await connectSocket(url, { cookie, origin: ORIGIN });
    refreshedSocket.send(JSON.stringify({ type: 'open', hostId, cols: 120, rows: 36, requestId: 'tab-refresh' }));

    expect(await nextJson<{ type: string; state?: string; serviceInstanceId?: string }>(refreshedSocket)).toEqual({ type: 'status', state: 'connected', serviceInstanceId: 'service-test' });
    expect((await nextMessage(refreshedSocket)).toString()).toBe('output before refresh\n');
    refreshedSocket.close();
  });

  it('does not create a new shell when a restored tab cannot be reattached', async () => {
    const { app, adapter } = await makeApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const cookie = cookieFrom(setup);
    const created = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { cookie },
      payload: {
        name: 'Fixture SSH',
        address: 'ssh-fixture',
        username: 'fixture',
        auth: { type: 'password', password: 'fixture-password' }
      }
    });
    const hostId = json<{ id: string }>(created).id;
    const url = await listen(app);
    const socket = await connectSocket(url, { cookie, origin: ORIGIN });

    socket.send(JSON.stringify({ type: 'open', hostId, cols: 120, rows: 36, requestId: 'tab-missing', reattachOnly: true }));

    expect(await nextJson<{ type: string; code?: string }>(socket)).toEqual(expect.objectContaining({
      type: 'error',
      code: 'SESSION_NEEDS_REOPEN'
    }));
    expect(adapter.channels).toHaveLength(0);
    socket.close();
  });

  it('returns stable errors for unknown hosts and malformed control frames', async () => {
    const { app } = await makeApp();
    const setup = await app.inject({ method: 'POST', url: '/api/setup', payload: { masterPassword: MASTER_PASSWORD } });
    const cookie = cookieFrom(setup);
    const url = await listen(app);
    const socket = await connectSocket(url, { cookie, origin: ORIGIN });

    socket.send(JSON.stringify({ type: 'open', hostId: 'unknown-host', cols: 80, rows: 24, requestId: 'tab-1' }));
    expect(await nextJson<{ type: string; code: string }>(socket)).toEqual(expect.objectContaining({
      type: 'error',
      code: 'HOST_NOT_FOUND'
    }));
    socket.close();
  });
});
