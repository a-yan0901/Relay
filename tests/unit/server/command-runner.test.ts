import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import type { HostMetadata } from '../../../src/shared/validation.js';
import type { SshConnectionResource, SshExecOptions, SshExecResult } from '../../../src/server/ssh/types.js';
import {
  assessCommandRisk,
  CommandRunner,
  expandCommandTemplate,
  redactCommandPreview,
  type CommandConnectionLease,
  type CommandResourceProvider
} from '../../../src/server/automation/command-runner.js';

const host = (id: string): HostMetadata => ({
  id,
  name: `Server ${id}`,
  address: `10.0.0.${id.slice(-1)}`,
  port: 22,
  username: 'deploy',
  authType: 'password',
  groupId: null,
  tags: [],
  isFavorite: false,
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  lastConnectedAt: null,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z'
});

const resource = (execute: (command: string, options?: SshExecOptions) => Promise<SshExecResult>): SshConnectionResource => ({
  openShell: vi.fn(),
  exec: vi.fn(execute),
  openSftp: vi.fn(),
  close: vi.fn()
});

const providerFor = (
  resources: ReadonlyMap<string, SshConnectionResource>,
  onOpen?: (hostId: string) => void
): CommandResourceProvider => ({
  open: vi.fn(async (hostId) => {
    onOpen?.(hostId);
    const next = resources.get(hostId);
    if (!next) throw new AppError('HOST_NOT_FOUND');
    const lease: CommandConnectionLease = { resource: next, close: () => next.close() };
    return lease;
  })
});

const runnerFor = (
  hostIds: readonly string[],
  provider: CommandResourceProvider,
  concurrency = 4
): CommandRunner => new CommandRunner({
  ownerId: 'owner-a',
  hostLookup: { get: (hostId, ownerId) => ownerId === 'owner-a' && hostIds.includes(hostId) ? host(hostId) : null },
  resourceProvider: provider,
  defaultConcurrency: concurrency
});

describe('CommandRunner', () => {
  it('expands explicit variables, preserves the command, and labels destructive commands', () => {
    const command = 'docker logs {{service}} --tail {{lines}}';
    expect(expandCommandTemplate(command, { service: 'api', lines: '50' })).toBe('docker logs api --tail 50');
    expect(command).toBe('docker logs {{service}} --tail {{lines}}');
    expect(() => expandCommandTemplate(command, { service: 'api' })).toThrowError(new AppError('COMMAND_RUN_VALIDATION_FAILED'));
    expect(assessCommandRisk('rm -rf /tmp/cache')).toEqual(expect.objectContaining({ requiresConfirmation: true }));
    expect(assessCommandRisk('rm -rf /tmp/cache').command).toBe('rm -rf /tmp/cache');
    expect(redactCommandPreview('deploy --service={{service}} --token={{token}}', { service: 'api', token: 'secret-value' })).toBe('deploy --service=api --token=••••');
  });

  it('requires explicit confirmation for multi-host and destructive runs', async () => {
    const next = resource(async () => ({ exitCode: 0 }));
    const runner = runnerFor(['host-1', 'host-2'], providerFor(new Map([['host-1', next], ['host-2', next]])));

    await expect(runner.start({
      command: 'uname -a', hostIds: ['host-1', 'host-2'], variables: {}, concurrency: 2, timeoutMs: 1_000, persistOutput: false
    })).rejects.toMatchObject({ code: 'COMMAND_RUN_VALIDATION_FAILED' });
    await expect(runner.start({
      command: 'rm -rf /tmp/cache', hostIds: ['host-1'], variables: {}, concurrency: 1, timeoutMs: 1_000, persistOutput: false
    })).rejects.toMatchObject({ code: 'COMMAND_RUN_VALIDATION_FAILED' });
  });

  it('snapshots targets, bounds concurrency, truncates output, and isolates a failed target', async () => {
    let active = 0;
    let peak = 0;
    const resources = new Map<string, SshConnectionResource>();
    for (const id of ['host-1', 'host-2', 'host-3']) {
      resources.set(id, resource(async (_command, options) => {
        active += 1;
        peak = Math.max(peak, active);
        options?.onStdout?.(Buffer.from(id === 'host-1' ? 'x'.repeat(300_000) : `ok-${id}`));
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return id === 'host-2' ? { exitCode: 7 } : { exitCode: 0 };
      }));
    }
    const runner = runnerFor(['host-1', 'host-2', 'host-3'], providerFor(resources), 2);
    const initial = await runner.start({
      command: 'echo {{value}}', hostIds: ['host-1', 'host-2', 'host-3'], variables: { value: 'safe' }, concurrency: 2, timeoutMs: 1_000, persistOutput: false, confirmed: true
    });
    const completed = await runner.waitFor(initial.id);

    expect(peak).toBeLessThanOrEqual(2);
    expect(completed.status).toBe('failed');
    expect(completed.targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ hostId: 'host-1', status: 'completed', outputBytes: 256 * 1024, truncated: true }),
      expect.objectContaining({ hostId: 'host-2', status: 'failed', exitCode: 7 }),
      expect.objectContaining({ hostId: 'host-3', status: 'completed' })
    ]));
    expect(completed.command).toBe('echo safe');
  });

  it('cancels queued targets before they start and reports owner isolation', async () => {
    let release: (() => void) | undefined;
    const first = resource(async (_command, options) => new Promise<SshExecResult>((resolve, reject) => {
      release = () => resolve({ exitCode: 0 });
      options?.signal?.addEventListener('abort', () => reject(new AppError('COMMAND_RUN_CANCELLED')), { once: true });
    }));
    const second = resource(async () => ({ exitCode: 0 }));
    const runner = runnerFor(['host-1', 'host-2'], providerFor(new Map([['host-1', first], ['host-2', second]])), 1);
    const initial = await runner.start({
      command: 'sleep 10', hostIds: ['host-1', 'host-2'], variables: {}, concurrency: 1, timeoutMs: 10_000, persistOutput: false, confirmed: true
    });
    await runner.cancel(initial.id);
    release?.();
    const cancelled = await runner.waitFor(initial.id);
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.targets.find((target) => target.hostId === 'host-2')?.status).toBe('cancelled');

    const otherOwner = runnerFor(['host-1'], providerFor(new Map([['host-1', second]])));
    await expect(otherOwner.get(initial.id)).resolves.toBeNull();
    await expect(otherOwner.cancel(initial.id)).rejects.toMatchObject({ code: 'COMMAND_RUN_NOT_FOUND' });
  });

  it('reports an exec timeout as a failed target instead of a user cancellation', async () => {
    const hanging = resource(async (_command, options) => new Promise<SshExecResult>((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => reject(new AppError('COMMAND_RUN_CANCELLED')), { once: true });
    }));
    const runner = runnerFor(['host-1'], providerFor(new Map([['host-1', hanging]])));
    const initial = await runner.start({
      command: 'sleep 10', hostIds: ['host-1'], variables: {}, concurrency: 1, timeoutMs: 1_000, persistOutput: false
    });

    const finished = await runner.waitFor(initial.id);
    expect(finished.status).toBe('failed');
    expect(finished.targets[0]).toEqual(expect.objectContaining({ status: 'failed', errorCode: 'COMMAND_RUN_TIMEOUT' }));
  });

  it('keeps the request id and target snapshot while rechecking the submitted target set', async () => {
    const next = resource(async () => ({ exitCode: 0 }));
    const runner = runnerFor(['host-1', 'host-2'], providerFor(new Map([['host-1', next], ['host-2', next]])));
    const snapshot = {
      hostIds: ['host-1', 'host-2'],
      source: 'workspace' as const,
      capturedAt: '2026-09-16T09:00:00.000Z',
      displayNames: ['Server host-1', 'Server host-2']
    };

    const initial = await runner.start({
      command: 'uname -a', hostIds: ['host-1', 'host-2'], variables: {}, concurrency: 2, timeoutMs: 1_000,
      persistOutput: false, confirmed: true, targetSelection: snapshot
    }, undefined, 'request-1');
    expect(initial).toMatchObject({ requestId: 'request-1', targetSelection: snapshot });

    await expect(runner.start({
      command: 'uname -a', hostIds: ['host-1'], variables: {}, concurrency: 1, timeoutMs: 1_000,
      persistOutput: false, confirmed: true, targetSelection: { ...snapshot, hostIds: ['host-2'], displayNames: ['Server host-2'] }
    })).rejects.toMatchObject({ code: 'COMMAND_RUN_VALIDATION_FAILED' });
  });
});
