import { describe, expect, it } from 'vitest';

import type { CommandTransport, FileTransport, SessionTransport } from '../../../src/shared/core/ports.js';
import type { CommandRun, CommandRunRequest, TransferJob, TransferRequest } from '../../../src/shared/core/models.js';

export const assertSessionTransportContract = async (transport: SessionTransport): Promise<void> => {
  const handle = await transport.openShell({
    sessionId: 'session-1',
    profile: { hostId: 'host-1', address: '10.0.0.8', port: 22, username: 'deploy', authType: 'password', jumpHostIds: [], keepaliveIntervalMs: 10_000, keepaliveCountMax: 3, reconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 }, hostKeyAlgorithm: null, hostKeyFingerprint: null },
    cols: 80,
    rows: 24
  });
  expect(handle.id).toBe('session-1');
  expect(handle.hostId).toBe('host-1');
  expect(typeof handle.write).toBe('function');
  expect(typeof handle.resize).toBe('function');
  expect(typeof handle.subscribe).toBe('function');
  const reconnected = await transport.reconnect('session-1');
  expect(reconnected.id).toBe('session-1');
  await transport.close('session-1');
};

export const assertFileTransportContract = async (transport: FileTransport): Promise<void> => {
  const request: TransferRequest = { kind: 'download', hostId: 'host-1', sourcePath: '/var/log/app.log', targetPath: 'app.log' };
  const job = await transport.createTransfer(request);
  expect(job.hostId).toBe(request.hostId);
  await transport.cancelTransfer(job.id);
};

export const assertCommandTransportContract = async (transport: CommandTransport): Promise<void> => {
  const request: CommandRunRequest = { command: 'uname -a', hostIds: ['host-1', 'host-2'], variables: {}, concurrency: 2, timeoutMs: 1_000, persistOutput: false, confirmed: true };
  const run = await transport.start(request);
  const loaded = await transport.get(run.id);
  expect(loaded?.id).toBe(run.id);
  expect(new Set(loaded?.targets.map((target) => target.hostId))).toEqual(new Set(request.hostIds));
  await transport.cancel(run.id);
};

const fakeTransfer = (id: string): TransferJob => ({ id, kind: 'download', hostId: 'host-1', sourcePath: '/source', targetPath: 'target', status: 'queued', completedBytes: 0, totalBytes: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
const fakeRun = (id: string): CommandRun => ({ id, command: 'uname -a', hostIds: ['host-1', 'host-2'], persistOutput: false, status: 'queued', targets: ['host-1', 'host-2'].map((hostId) => ({ hostId, status: 'queued', exitCode: null, output: '', outputBytes: 0 })), createdAt: new Date().toISOString() });

describe('shared core adapter contracts', () => {
  it('defines the lifecycle contract for session, file and command transports', async () => {
    let closed = false;
    const sessions = new Map<string, { id: string; hostId: string }>();
    const sessionTransport: SessionTransport = {
      async openShell(request) { const value = { id: request.sessionId, hostId: request.profile.hostId }; sessions.set(value.id, value); return { ...value, write: () => {}, resize: () => {}, close: () => { closed = true; }, subscribe: () => () => {} }; },
      async reconnect(sessionId) { const value = sessions.get(sessionId); if (!value) throw new Error('missing'); return { ...value, write: () => {}, resize: () => {}, close: () => {}, subscribe: () => () => {} }; },
      async close() { closed = true; }
    };
    await assertSessionTransportContract(sessionTransport);
    expect(closed).toBe(true);

    let cancelled = '';
    const fileTransport: FileTransport = { async list() { return []; }, async createTransfer() { return fakeTransfer('transfer-1'); }, async cancelTransfer(id) { cancelled = id; } };
    await assertFileTransportContract(fileTransport);
    expect(cancelled).toBe('transfer-1');

    let cancelledRun = '';
    const runs = new Map<string, CommandRun>();
    const commandTransport: CommandTransport = { async start() { const run = fakeRun('run-1'); runs.set(run.id, run); return run; }, async get(id) { return runs.get(id) ?? null; }, async cancel(id) { cancelledRun = id; } };
    await assertCommandTransportContract(commandTransport);
    expect(cancelledRun).toBe('run-1');
  });
});
