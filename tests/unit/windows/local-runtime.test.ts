import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { createWindowsLocalRuntime, type WindowsLocalRuntimeHandle } from '../../../apps/windows/local-runtime.js';
import type { SshAdapterPort, SshChannel } from '../../../src/server/ssh/types.js';

const request = async (runtime: WindowsLocalRuntimeHandle, requestId: string, operation: string, payload: unknown) => {
  const response = await runtime.router.dispatch({ version: 1, requestId, operation, payload });
  if (!response.ok) throw new Error(`${response.error.code}: ${response.error.message}`);
  return response.result;
};

describe('Windows local runtime', () => {
  let runtime: WindowsLocalRuntimeHandle | undefined;

  afterEach(async () => {
    await runtime?.close();
    runtime = undefined;
  });

  it('keeps vault and workspace state local without starting an HTTP server', async () => {
    runtime = createWindowsLocalRuntime({ dataDir: ':memory:' });
    await expect(runtime.router.dispatch({ version: 1, requestId: 'status-1', operation: 'vault.status', payload: {} })).resolves.toMatchObject({ ok: true, result: { phase: 'uninitialized' } });
    await expect(request(runtime, 'setup-1', 'vault.setup', { masterPassword: 'test-password' })).resolves.toEqual({ phase: 'unlocked' });

    const loaded = await request(runtime, 'workspace-1', 'workspace.load', {});
    expect(loaded).toMatchObject({ version: 0, tabs: [], activeTabId: null });
    await request(runtime, 'workspace-2', 'workspace.save', { expectedVersion: 0, state: loaded });
    await request(runtime, 'vault.lock', 'vault.lock', {});
    await expect(runtime.router.dispatch({ version: 1, requestId: 'workspace-3', operation: 'workspace.load', payload: {} })).resolves.toMatchObject({ ok: false, error: { code: 'VAULT_LOCKED' } });
  });

  it('keeps host-key confirmation inside the native IPC session', async () => {
    const channel = new EventEmitter() as SshChannel & EventEmitter;
    channel.write = () => undefined;
    channel.resize = () => undefined;
    channel.close = () => { channel.emit('close'); };
    const sshAdapter: SshAdapterPort = {
      async connect(config, callbacks) {
        const accepted = await callbacks.onHostKey({ algorithm: 'ssh-ed25519', fingerprint: 'SHA256:abc', address: 'example.com', port: 22, hostId: config.hostId, reason: 'first-seen' });
        if (!accepted) throw new Error('host key rejected');
        callbacks.onStatus?.('connected');
        return channel;
      },
      async testConnection() { return { ok: true }; }
    };
    const confirm = vi.fn(async () => true);
    const openExternal = vi.fn(async () => undefined);
    runtime = createWindowsLocalRuntime({ dataDir: ':memory:', sshAdapter, systemServices: { confirm, openExternal } });
    const events: Array<{ kind: string; payload: unknown }> = [];
    runtime.subscribe((event) => events.push({ kind: event.kind, payload: event.payload }));
    await request(runtime, 'setup-2', 'vault.setup', { masterPassword: 'test-password' });
    await expect(request(runtime, 'confirm-1', 'system.confirm', { message: 'continue?' })).resolves.toEqual({ confirmed: true });
    await request(runtime, 'external-1', 'system.openExternal', { url: 'https://example.com' });
    expect(confirm).toHaveBeenCalledWith('continue?');
    expect(openExternal).toHaveBeenCalledWith('https://example.com/');
    const host = await request(runtime, 'host-1', 'hosts.create', { input: { name: 'Test', address: 'example.com', port: 22, username: 'root', auth: { type: 'password', password: 'secret' } } }) as { id: string };
    const openPromise = runtime.router.dispatch({ version: 1, requestId: 'open-1', operation: 'sessions.openShell', payload: { request: { requestId: 'session-1', hostId: host.id, cols: 80, rows: 24 } } });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'terminal.host-key')).toBe(true));
    await expect(request(runtime, 'trust-1', 'sessions.hostKeyDecision', { sessionId: 'session-1', decision: 'trust', fingerprint: 'SHA256:abc' })).resolves.toMatchObject({ accepted: true });
    await expect(openPromise).resolves.toMatchObject({ ok: true, result: { sessionId: 'session-1' } });
    await request(runtime, 'close-1', 'sessions.close', { sessionId: 'session-1' });
  });

  it('streams native file saves through a bounded writer handle', async () => {
    const writer = {
      write: vi.fn(async (_data: Uint8Array) => undefined),
      seek: vi.fn(async (_position: number) => undefined),
      close: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined)
    };
    const open = vi.fn(async () => writer);
    runtime = createWindowsLocalRuntime({ dataDir: ':memory:', systemServices: { fileSave: { open } } });
    await request(runtime, 'setup-file-save', 'vault.setup', { masterPassword: 'test-password' });
    const opened = await request(runtime, 'file-open', 'system.fileSave.open', { name: 'output.bin', mimeType: 'application/octet-stream' }) as { writerId: string };
    await request(runtime, 'file-write', 'system.fileSave.write', { writerId: opened.writerId, data: Buffer.from('chunk').toString('base64url') });
    await request(runtime, 'file-seek', 'system.fileSave.seek', { writerId: opened.writerId, position: 5 });
    await request(runtime, 'file-close', 'system.fileSave.close', { writerId: opened.writerId });

    expect(open).toHaveBeenCalledWith({ name: 'output.bin', mimeType: 'application/octet-stream' });
    expect(writer.write).toHaveBeenCalledWith(new Uint8Array(Buffer.from('chunk')));
    expect(writer.seek).toHaveBeenCalledWith(5);
    expect(writer.close).toHaveBeenCalledOnce();
    expect(writer.cancel).not.toHaveBeenCalled();
  });

  it('chunks portable vault bundles across the bounded desktop IPC frame', async () => {
    runtime = createWindowsLocalRuntime({ dataDir: ':memory:' });
    await request(runtime, 'setup-bundle', 'vault.setup', { masterPassword: 'test-password' });
    const password = 'p'.repeat(3500);
    for (let index = 0; index < 10; index += 1) {
      await request(runtime, `host-bundle-${index}`, 'hosts.create', {
        input: { name: `Bundle host ${index}`, address: `bundle-${index}.example.com`, port: 22, username: 'root', auth: { type: 'password', password } }
      });
    }

    const started = await request(runtime, 'bundle-export', 'imports.exportVaultBundle', { exportPassword: 'test-password' }) as { bundleId: string };
    const chunks: string[] = [];
    let cursor = 0;
    for (;;) {
      const part = await request(runtime, `bundle-read-${cursor}`, 'imports.readVaultBundleChunk', { bundleId: started.bundleId, cursor }) as { data: string; nextCursor: number; done: boolean };
      chunks.push(Buffer.from(part.data, 'base64url').toString('utf8'));
      if (part.done) break;
      expect(part.nextCursor).toBeGreaterThan(cursor);
      cursor = part.nextCursor;
    }
    expect(chunks.length).toBeGreaterThan(1);
    const bundle = chunks.join('');
    expect(Buffer.byteLength(bundle, 'utf8')).toBeGreaterThan(32 * 1024);
    expect(bundle).toContain('"format":"webssh-vault"');

    await request(runtime, 'bundle-release', 'imports.releaseVaultBundle', { bundleId: started.bundleId });
    await expect(request(runtime, 'bundle-read-expired', 'imports.readVaultBundleChunk', { bundleId: started.bundleId, cursor: 0 })).rejects.toThrow('VAULT_BUNDLE_PREVIEW_EXPIRED');
  });
});
