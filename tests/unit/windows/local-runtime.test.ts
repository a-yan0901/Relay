import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';

import { createWindowsLocalRuntime, type WindowsLocalRuntimeHandle } from '../../../apps/windows/local-runtime.js';
import type { SshAdapterPort, SshChannel } from '../../../src/server/ssh/types.js';

const FULL_VECTOR = JSON.parse(readFileSync(new URL('../../fixtures/vault-bundle-v1-full-vector.json', import.meta.url), 'utf8')) as {
  exportPassword: string;
  bundle: string;
  expected: { hosts: number; groups: number; identities: number; terminalProfiles: number; tags: string[]; privateKeyHost: string; groupHost: string };
};

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

  it('imports the fixed full vector through Windows IPC without losing inherited fields', async () => {
    runtime = createWindowsLocalRuntime({ dataDir: ':memory:' });
    await request(runtime, 'setup-full-vector', 'vault.setup', { masterPassword: 'test-password' });

    const preview = await request(runtime, 'preview-full-vector', 'imports.previewVaultImport', {
      exportPassword: FULL_VECTOR.exportPassword,
      bundle: FULL_VECTOR.bundle
    }) as { previewId: string; hostCount: number; groupCount: number; identityCount: number; conflicts: unknown[] };
    expect(preview).toMatchObject({
      hostCount: FULL_VECTOR.expected.hosts,
      groupCount: FULL_VECTOR.expected.groups,
      identityCount: FULL_VECTOR.expected.identities,
      conflicts: []
    });

    const applied = await request(runtime, 'apply-full-vector', 'imports.applyVaultImport', {
      previewId: preview.previewId,
      resolution: { hostConflicts: 'skip', groupConflicts: 'reuse', identityConflicts: 'reuse' }
    });
    expect(applied).toMatchObject({
      importedHosts: FULL_VECTOR.expected.hosts,
      importedGroups: FULL_VECTOR.expected.groups,
      importedIdentities: FULL_VECTOR.expected.identities
    });

    const hosts = await request(runtime, 'list-full-vector-hosts', 'hosts.list', {}) as Array<Record<string, unknown>>;
    const groups = await request(runtime, 'list-full-vector-groups', 'groups.list', {}) as Array<Record<string, unknown>>;
    const identities = await request(runtime, 'list-full-vector-identities', 'identities.list', {}) as Array<Record<string, unknown>>;
    const profiles = await request(runtime, 'list-full-vector-profiles', 'terminalProfiles.list', {}) as Array<Record<string, unknown>>;
    const groupHost = hosts.find((host) => host.id === FULL_VECTOR.expected.groupHost);
    const privateKeyHost = hosts.find((host) => host.id === FULL_VECTOR.expected.privateKeyHost);

    expect(hosts).toHaveLength(FULL_VECTOR.expected.hosts);
    expect(groups).toHaveLength(FULL_VECTOR.expected.groups);
    expect(identities).toHaveLength(FULL_VECTOR.expected.identities);
    expect(profiles.filter((profile) => profile.id === 'vector-terminal-profile')).toHaveLength(FULL_VECTOR.expected.terminalProfiles);
    expect(groupHost).toMatchObject({
      credentialSource: { type: 'group' },
      tags: FULL_VECTOR.expected.tags,
      groupId: 'vector-group-child',
      terminalProfileId: 'vector-terminal-profile'
    });
    expect(privateKeyHost).toMatchObject({
      authType: 'private_key',
      credentialSource: { type: 'inline' },
      jumpHostIds: [FULL_VECTOR.expected.groupHost],
      tags: ['key host']
    });
    expect(groups.find((group) => group.id === 'vector-group-root')).toMatchObject({
      defaultIdentityId: 'vector-identity-password',
      connectionProfile: { keepaliveIntervalMs: 4_000 }
    });
    expect(identities.find((identity) => identity.id === 'vector-identity-key')).toMatchObject({ name: 'Vector Key', type: 'private_key' });
  });

  it('rejects a wrong password and tampered fixed vector without writing the desktop vault', async () => {
    runtime = createWindowsLocalRuntime({ dataDir: ':memory:' });
    await request(runtime, 'setup-full-vector-rejection', 'vault.setup', { masterPassword: 'test-password' });

    await expect(request(runtime, 'preview-full-vector-wrong-password', 'imports.previewVaultImport', {
      exportPassword: 'wrong-password',
      bundle: FULL_VECTOR.bundle
    })).rejects.toThrow('VAULT_BUNDLE_INVALID');

    const tampered = JSON.parse(FULL_VECTOR.bundle) as { payload: { ciphertext: string } };
    const ciphertext = Buffer.from(tampered.payload.ciphertext, 'base64');
    ciphertext[0] ^= 1;
    tampered.payload.ciphertext = ciphertext.toString('base64');
    await expect(request(runtime, 'preview-full-vector-tampered', 'imports.previewVaultImport', {
      exportPassword: FULL_VECTOR.exportPassword,
      bundle: JSON.stringify(tampered)
    })).rejects.toThrow('VAULT_BUNDLE_INVALID');

    await expect(request(runtime, 'list-after-full-vector-rejection', 'hosts.list', {})).resolves.toEqual([]);
    await expect(request(runtime, 'groups-after-full-vector-rejection', 'groups.list', {})).resolves.toEqual([]);
    await expect(request(runtime, 'identities-after-full-vector-rejection', 'identities.list', {})).resolves.toEqual([]);
  });
});
