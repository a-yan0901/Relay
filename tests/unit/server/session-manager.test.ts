import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { SshSessionManager } from '../../../src/server/ssh/session-manager.js';
import type {
  SshAdapterPort,
  SshChannel,
  SshConnectConfig,
  SshConnectCallbacks
} from '../../../src/server/ssh/types.js';

class FakeChannel extends EventEmitter implements SshChannel {
  closeCalls = 0;

  write(_data: string | Buffer): void {}

  resize(_cols: number, _rows: number): void {}

  close(): void {
    this.closeCalls += 1;
    this.emit('close');
  }
}

class FakeAdapter implements SshAdapterPort {
  readonly channels: FakeChannel[] = [];
  connectCalls = 0;

  async connect(_config: SshConnectConfig, _callbacks: SshConnectCallbacks): Promise<SshChannel> {
    this.connectCalls += 1;
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }

  async testConnection(): Promise<{ ok: boolean }> {
    return { ok: true };
  }
}

const config: SshConnectConfig = {
  hostId: 'host-1',
  address: '10.0.0.8',
  port: 22,
  username: 'deploy',
  auth: { type: 'password', password: 'fixture-password' },
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  cols: 120,
  rows: 36
};

describe('SshSessionManager', () => {
  it('opens one channel per tab and enforces the concurrent session limit', async () => {
    const adapter = new FakeAdapter();
    const manager = new SshSessionManager({ adapter, maxSessions: 1, detachGraceMs: 30_000 });

    const first = await manager.open('tab-1', config, { onHostKey: async () => true });
    expect(first).toBe(adapter.channels[0]);
    await expect(manager.open('tab-2', config, { onHostKey: async () => true }))
      .rejects.toMatchObject({ code: 'SSH_SESSION_LIMIT' });
    await expect(manager.open('tab-1', config, { onHostKey: async () => true }))
      .rejects.toMatchObject({ code: 'SSH_CONNECTION_FAILED' });
  });

  it('retains a detached channel for reattach and closes it after the grace period', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeAdapter();
      const manager = new SshSessionManager({ adapter, maxSessions: 2, detachGraceMs: 30_000 });
      const channel = await manager.open('tab-1', config, { onHostKey: async () => true });

      manager.detach('tab-1');
      expect(manager.reattach('tab-1')).toBe(channel);
      manager.detach('tab-1');
      vi.advanceTimersByTime(29_999);
      expect(manager.reattach('tab-1')).toBe(channel);
      manager.detach('tab-1');
      vi.advanceTimersByTime(30_000);
      expect(manager.reattach('tab-1')).toBeNull();
      expect((channel as FakeChannel).closeCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('closes exactly once and does not reuse sessions after closeAll', async () => {
    const adapter = new FakeAdapter();
    const manager = new SshSessionManager({ adapter, maxSessions: 2, detachGraceMs: 30_000 });
    const first = await manager.open('tab-1', config, { onHostKey: async () => true });
    const second = await manager.open('tab-2', config, { onHostKey: async () => true });

    manager.close('tab-1');
    manager.close('tab-1');
    expect((first as FakeChannel).closeCalls).toBe(1);
    manager.closeAll();
    expect((second as FakeChannel).closeCalls).toBe(1);
    expect(manager.reattach('tab-1')).toBeNull();
    expect(manager.reattach('tab-2')).toBeNull();
  });
});
