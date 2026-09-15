import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import { Ssh2Adapter, Ssh2ResourceAdapter } from '../../../src/server/ssh/ssh2-adapter.js';
import type { SshConnectConfig } from '../../../src/server/ssh/types.js';

class FakeChannel extends EventEmitter {
  readonly writes: Array<string | Buffer> = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  closeCalls = 0;

  write(data: string | Buffer): void {
    this.writes.push(data);
  }

  setWindow(rows: number, cols: number): void {
    this.resizes.push({ cols, rows });
  }

  close(): void {
    this.closeCalls += 1;
    this.emit('close');
  }

  emitStderr(data: Buffer): void {
    const stream = (this as FakeChannel & { stderr?: EventEmitter }).stderr;
    stream?.emit('data', data);
  }

  stderr = new EventEmitter();
}

class FakeClient extends EventEmitter {
  connectOptions: Record<string, unknown> | undefined;
  shellOptions: Record<string, unknown> | undefined;
  endCalls = 0;
  readonly channel = new FakeChannel();

  connect(options: Record<string, unknown>): void {
    this.connectOptions = options;
    queueMicrotask(() => this.emit('ready'));
  }

  shell(options: Record<string, unknown>, callback: (error: Error | undefined, channel: FakeChannel) => void): void {
    this.shellOptions = options;
    callback(undefined, this.channel);
  }

  end(): void {
    this.endCalls += 1;
    this.emit('close');
  }
}

const config = (auth: SshConnectConfig['auth']): SshConnectConfig => ({
  hostId: 'host-1',
  address: '10.0.0.8',
  port: 22,
  username: 'deploy',
  auth,
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  cols: 120,
  rows: 36
});

describe('Ssh2Adapter', () => {
  it('maps password credentials, connection options, and PTY dimensions', async () => {
    const client = new FakeClient();
    const adapter = new Ssh2Adapter({ clientFactory: () => client });
    const channel = await adapter.connect(config({ type: 'password', password: 'fixture-password' }), {
      onHostKey: async () => true
    });

    expect(client.connectOptions).toMatchObject({
      host: '10.0.0.8',
      port: 22,
      username: 'deploy',
      password: 'fixture-password',
      readyTimeout: 60_000,
      keepaliveInterval: 10_000,
      keepaliveCountMax: 3,
      hostHash: 'sha256'
    });
    expect(client.shellOptions).toEqual({ term: 'xterm-256color', cols: 120, rows: 36, width: 0, height: 0 });
    expect(channel).toBeDefined();
  });

  it('maps private keys and forwards channel data, stderr, input, resize, and close', async () => {
    const client = new FakeClient();
    const adapter = new Ssh2Adapter({ clientFactory: () => client });
    const channel = await adapter.connect(config({
      type: 'private_key',
      privateKey: 'private-key-fixture',
      passphrase: 'key-passphrase-fixture'
    }), { onHostKey: async () => true });
    const events: { data: Buffer[]; stderr: Buffer[]; closes: number } = { data: [], stderr: [], closes: 0 };
    channel.on('data', (data) => events.data.push(data));
    channel.on('stderr', (data) => events.stderr.push(data));
    channel.on('close', () => { events.closes += 1; });

    expect(client.connectOptions).toMatchObject({
      privateKey: 'private-key-fixture',
      passphrase: 'key-passphrase-fixture'
    });
    client.channel.emit('data', 'output');
    client.channel.emitStderr(Buffer.from('stderr'));
    channel.write('input');
    channel.resize(80, 24);
    expect(events.data[0].toString()).toBe('output');
    expect(events.stderr[0].toString()).toBe('stderr');
    expect(client.channel.writes).toEqual(['input']);
    expect(client.channel.resizes).toEqual([{ cols: 80, rows: 24 }]);

    channel.close();
    channel.close();
    expect(client.channel.closeCalls).toBe(1);
    expect(client.endCalls).toBe(1);
    expect(events.closes).toBe(1);
  });

  it('applies per-host keepalive settings over adapter defaults', async () => {
    const client = new FakeClient();
    const adapter = new Ssh2Adapter({ clientFactory: () => client });
    await adapter.connect({
      ...config({ type: 'password', password: 'fixture-password' }),
      keepaliveInterval: 1_500,
      keepaliveCountMax: 9
    }, { onHostKey: async () => true });

    expect(client.connectOptions).toMatchObject({ keepaliveInterval: 1_500, keepaliveCountMax: 9 });
  });

  it('maps authentication failures to a stable application error', async () => {
    const client = new FakeClient();
    const adapter = new Ssh2Adapter({ clientFactory: () => client });
    client.connect = () => queueMicrotask(() => client.emit('error', new Error('All configured authentication methods failed')));

    await expect(adapter.connect(config({ type: 'password', password: 'fixture-password' }), {
      onHostKey: async () => true
    })).rejects.toMatchObject({ code: 'SSH_AUTH_FAILED' });
  });

  it('exposes a reusable connection resource with exec and shell lifecycle diagnostics', async () => {
    const client = new FakeClient();
    const diagnostics: Array<{ stage: string; status: string }> = [];
    const adapter = new Ssh2ResourceAdapter({ clientFactory: () => client });
    const resource = await adapter.connect(config({ type: 'password', password: 'fixture-password' }), {
      onHostKey: async () => true,
      onDiagnostic: (event) => diagnostics.push({ stage: event.stage, status: event.status })
    });

    expect(diagnostics.map(({ stage }) => stage)).toEqual(['resolve', 'resolve', 'tcp', 'tcp', 'authentication']);
    const channel = await resource.openShell({ cols: 80, rows: 24, term: 'xterm-256color' });
    expect(client.shellOptions).toEqual({ term: 'xterm-256color', cols: 80, rows: 24, width: 0, height: 0 });
    expect(diagnostics.at(-1)).toEqual({ stage: 'channel', status: 'succeeded' });
    channel.close();
    resource.close();
  });
});
