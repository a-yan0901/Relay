import { describe, expect, it, vi } from 'vitest';

import type { NativeEventFrame } from '../../../src/shared/native/bridge.js';
import { createNativeCoreRuntime, NATIVE_TRANSFER_CHUNK_BYTES, type NativeOperationPort } from '../../../src/shared/native/core-runtime.js';

describe('native core runtime adapter', () => {
  it('maps local operations without HTTP and keeps file chunks bounded', async () => {
    const calls: Array<{ operation: string; payload: unknown }> = [];
    const invoke = vi.fn(async <T,>(operation: string, payload: unknown): Promise<T> => {
      calls.push({ operation, payload });
      if (operation === 'vault.status') return { phase: 'unlocked' } as T;
      if (operation === 'hosts.list') return [] as T;
      if (operation === 'sessions.openShell') return { sessionId: 'session-1', hostId: 'host-1' } as T;
      if (operation === 'files.createTransfer') return { id: 'transfer-1', kind: 'upload', hostId: 'host-1', sourcePath: 'source', targetPath: '/tmp/source', status: 'queued', completedBytes: 0, totalBytes: 0, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' } as T;
      if (operation === 'files.upload') return { id: 'transfer-1', kind: 'upload', hostId: 'host-1', sourcePath: 'source', targetPath: '/tmp/source', status: 'completed', completedBytes: 3, totalBytes: 3, createdAt: '2026-09-18T00:00:00.000Z', updatedAt: '2026-09-18T00:00:00.000Z' } as T;
      if (operation === 'files.download') return { data: 'b2s', done: true } as T;
      if (operation === 'files.getTransfer') return null as T;
      if (operation === 'files.listTransfers') return [] as T;
      if (operation === 'files.list') return [] as T;
      if (operation === 'imports.exportOpenSshConfig' || operation === 'imports.exportCsv') return { data: '' } as T;
      if (operation === 'imports.exportVaultBundle') return { bundle: 'opaque-bundle' } as T;
      return undefined as T;
    });
    const listeners = new Set<(event: NativeEventFrame) => void>();
    const port: NativeOperationPort = {
      invoke,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }
    };
    const runtime = createNativeCoreRuntime({ platform: 'desktop', port });

    await expect(runtime.vault.status()).resolves.toEqual({ phase: 'unlocked' });
    await runtime.hosts.list({ query: 'prod' });
    const session = await runtime.sessions.openShell({
      sessionId: 'session-1',
      profile: {
        hostId: 'host-1', address: '10.0.0.8', port: 22, username: 'deploy', authType: 'password', jumpHostIds: [],
        keepaliveIntervalMs: 10_000, keepaliveCountMax: 3, reconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
        hostKeyAlgorithm: null, hostKeyFingerprint: null
      },
      cols: 80,
      rows: 24
    });
    session.write('pwd');
    session.resize(100, 30);
    await runtime.sessions.close(session.id);

    const transfer = await runtime.files.createTransfer({ kind: 'upload', hostId: 'host-1', sourcePath: 'source', targetPath: '/tmp/source', totalBytes: 3 });
    await runtime.files.upload(transfer.id, { name: 'source', size: 3, async *stream() { yield new Uint8Array([1, 2, 3]); } });
    const downloaded: Uint8Array[] = [];
    for await (const chunk of await runtime.files.download('transfer-1')) downloaded.push(chunk);
    expect(downloaded).toEqual([new Uint8Array([0x6f, 0x6b])]);
    expect(NATIVE_TRANSFER_CHUNK_BYTES).toBeLessThanOrEqual(32 * 1024);
    expect(calls.some(({ operation }) => operation === 'sessions.write')).toBe(true);
    expect(calls.some(({ operation }) => operation === 'sessions.resize')).toBe(true);
    const uploadCall = calls.find(({ operation }) => operation === 'files.upload');
    expect(uploadCall?.payload).toEqual(expect.objectContaining({ final: true }));
    expect(typeof (uploadCall?.payload as { data: unknown }).data).toBe('string');
    expect(listeners.size).toBe(0);
  });

  it('routes terminal output to one bounded event subscription', async () => {
    let emit: ((event: NativeEventFrame) => void) | undefined;
    const port: NativeOperationPort = {
      invoke: vi.fn(async <T,>(operation: string): Promise<T> => {
        if (operation === 'sessions.openShell') return { sessionId: 'session-1', hostId: 'host-1' } as T;
        return undefined as T;
      }),
      subscribe(listener) { emit = listener; return () => { emit = undefined; }; }
    };
    const runtime = createNativeCoreRuntime({ platform: 'android', port });
    const handle = await runtime.sessions.openShell({ sessionId: 'session-1', profile: { hostId: 'host-1', address: 'host', port: 22, username: 'u', authType: 'password', jumpHostIds: [], keepaliveIntervalMs: 1000, keepaliveCountMax: 3, reconnect: { enabled: true, maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 }, hostKeyAlgorithm: null, hostKeyFingerprint: null }, cols: 80, rows: 24 });
    const onEvent = vi.fn();
    handle.subscribe(onEvent);
    emit?.({ version: 1, generation: 1, sequence: 1, kind: 'terminal.output', sessionId: 'session-1', payload: { stream: 'stdout', data: 'ok' } });
    expect(onEvent).toHaveBeenCalledWith({ type: 'data', data: 'ok' });
  });

  it('chunks Android Vault bundles instead of exceeding the native frame limit', async () => {
    const calls: Array<{ operation: string; payload: unknown }> = [];
    const writtenChunks: string[] = [];
    const port: NativeOperationPort = {
      invoke: vi.fn(async <T,>(operation: string, payload: unknown): Promise<T> => {
        calls.push({ operation, payload });
        if (operation === 'imports.exportVaultBundle') return { bundleId: 'bundle-1' } as T;
        if (operation === 'imports.readVaultBundleChunk') return { data: 'cG9ydGFibGU', nextCursor: 9, done: true } as T;
        if (operation === 'imports.beginVaultImport') return { importId: 'import-1' } as T;
        if (operation === 'imports.writeVaultImportChunk') {
          writtenChunks.push((payload as { data: string }).data);
          return undefined as T;
        }
        if (operation === 'imports.finishVaultImport') return { previewId: 'preview-1', hostCount: 1, groupCount: 0, identityCount: 0, conflicts: [], expiresAt: '' } as T;
        return undefined as T;
      }),
      subscribe() { return () => undefined; }
    };
    const runtime = createNativeCoreRuntime({ platform: 'android', port });

    await expect(runtime.imports.exportVaultBundle('export-password')).resolves.toBe('portable');
    await expect(runtime.imports.previewVaultImport('export-password', 'x'.repeat(70_000))).resolves.toMatchObject({ previewId: 'preview-1' });

    expect(calls.map(({ operation }) => operation)).toEqual([
      'imports.exportVaultBundle',
      'imports.readVaultBundleChunk',
      'imports.releaseVaultBundle',
      'imports.beginVaultImport',
      'imports.writeVaultImportChunk',
      'imports.writeVaultImportChunk',
      'imports.writeVaultImportChunk',
      'imports.finishVaultImport'
    ]);
    expect(writtenChunks).toHaveLength(3);
    expect(writtenChunks.every((chunk) => chunk.length <= 48 * 1024)).toBe(true);
  });

  it('does not lose the first status event emitted during shell open', async () => {
    let emit: ((event: NativeEventFrame) => void) | undefined;
    const port: NativeOperationPort = {
      invoke: vi.fn(async <T,>(operation: string): Promise<T> => {
        if (operation === 'sessions.openShell') {
          emit?.({ version: 1, generation: 1, sequence: 1, kind: 'terminal.output', sessionId: 'session-1', payload: { stream: 'stdout', data: 'early' } });
          return { sessionId: 'session-1', hostId: 'host-1' } as T;
        }
        return undefined as T;
      }),
      subscribe(listener) { emit = listener; return () => { emit = undefined; }; }
    };
    const runtime = createNativeCoreRuntime({ platform: 'desktop', port });
    const handle = await runtime.sessions.openShell({ sessionId: 'session-1', profile: { hostId: 'host-1', address: 'host', port: 22, username: 'u', authType: 'password', jumpHostIds: [], keepaliveIntervalMs: 1000, keepaliveCountMax: 3, reconnect: { enabled: true, maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 }, hostKeyAlgorithm: null, hostKeyFingerprint: null }, cols: 80, rows: 24 });
    const onEvent = vi.fn();
    handle.subscribe(onEvent);
    expect(onEvent).toHaveBeenCalledWith({ type: 'data', data: 'early' });
  });

  it('bounds terminal write buffering and reports backpressure instead of dropping silently', async () => {
    const pendingWrites: Array<() => void> = [];
    const writeCalls: string[] = [];
    const port: NativeOperationPort = {
      invoke: vi.fn(async <T,>(operation: string, payload: unknown): Promise<T> => {
        if (operation === 'sessions.openShell') return { sessionId: 'session-1', hostId: 'host-1' } as T;
        if (operation === 'sessions.write') {
          writeCalls.push((payload as { data: string }).data);
          await new Promise<void>((resolve) => pendingWrites.push(resolve));
        }
        return undefined as T;
      }),
      subscribe() { return () => undefined; }
    };
    const runtime = createNativeCoreRuntime({ platform: 'desktop', port });
    const handle = await runtime.sessions.openShell({ sessionId: 'session-1', profile: { hostId: 'host-1', address: 'host', port: 22, username: 'u', authType: 'password', jumpHostIds: [], keepaliveIntervalMs: 1000, keepaliveCountMax: 3, reconnect: { enabled: true, maxAttempts: 1, baseDelayMs: 10, maxDelayMs: 10 }, hostKeyAlgorithm: null, hostKeyFingerprint: null }, cols: 80, rows: 24 });
    const onEvent = vi.fn();
    handle.subscribe(onEvent);

    for (let index = 0; index < 8; index += 1) handle.write(`input-${index}`);
    await vi.waitFor(() => expect(writeCalls).toHaveLength(1));
    handle.write('overflow');

    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({
      type: 'diagnostic',
      diagnostic: expect.objectContaining({ errorCode: 'NATIVE_WRITE_BACKPRESSURE', state: 'interrupted' })
    }));

    for (let index = 0; index < 8; index += 1) {
      await vi.waitFor(() => expect(pendingWrites.length).toBeGreaterThan(0));
      pendingWrites.shift()?.();
    }
    await runtime.sessions.close(handle.id);
    expect(writeCalls).toHaveLength(8);
  });
});
