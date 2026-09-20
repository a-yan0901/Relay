import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createWindowsLocalRuntime, type WindowsLocalRuntimeHandle } from '../../../apps/windows/local-runtime.js';
import { openDatabase } from '../../../src/server/db/database.js';
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

  it('keeps the local Vault, Host, and workspace across a runtime restart', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'relay-windows-runtime-restart-'));
    let first: WindowsLocalRuntimeHandle | undefined;
    try {
      first = createWindowsLocalRuntime({ dataDir });
      await request(first, 'restart-setup', 'vault.setup', { masterPassword: 'restart-password' });
      const host = await request(first, 'restart-host-create', 'hosts.create', {
        input: { name: 'Restart Host', address: 'restart.invalid', port: 22, username: 'ops', auth: { type: 'password', password: 'synthetic-only' } }
      }) as { id: string };
      const state = await request(first, 'restart-workspace-load', 'workspace.load', {}) as { version: number; tabs: unknown[]; activeTabId: string | null; layout: unknown; filters: unknown };
      await request(first, 'restart-workspace-save', 'workspace.save', {
        expectedVersion: state.version,
        state: { ...state, filters: { query: 'restart', groupId: null, favoriteOnly: true } }
      });
      await first.close();
      first = undefined;

      runtime = createWindowsLocalRuntime({ dataDir });
      await expect(request(runtime, 'restart-status', 'vault.status', {})).resolves.toEqual({ phase: 'locked' });
      await request(runtime, 'restart-unlock', 'vault.unlock', { masterPassword: 'restart-password' });
      await expect(request(runtime, 'restart-host-list', 'hosts.list', {})).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: host.id, name: 'Restart Host' })]));
      await expect(request(runtime, 'restart-workspace-reload', 'workspace.load', {})).resolves.toMatchObject({ version: 1, filters: { query: 'restart', groupId: null, favoriteOnly: true } });
    } finally {
      await runtime?.close();
      runtime = undefined;
      await first?.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it('runs the startup migration against a legacy desktop database before serving hosts', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'relay-windows-runtime-migration-'));
    const databasePath = join(dataDir, 'relay.sqlite');
    const legacyDatabase = openDatabase(databasePath);
    legacyDatabase.exec(`
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, name)
      );
      CREATE TABLE hosts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'private_key')),
        credential_ciphertext TEXT NOT NULL,
        credential_version INTEGER NOT NULL DEFAULT 1,
        host_key_algorithm TEXT,
        host_key_fingerprint TEXT,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        jump_host_ids_json TEXT NOT NULL DEFAULT '[]',
        connection_profile_json TEXT NOT NULL,
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
        last_connected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO groups (id, owner_id, name, sort_order, created_at, updated_at)
        VALUES ('legacy-group', 'default', 'Legacy group', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO hosts (
        id, owner_id, name, address, port, username, auth_type, credential_ciphertext,
        credential_version, group_id, connection_profile_json, created_at, updated_at
      ) VALUES (
        'legacy-host', 'default', 'Legacy host', 'legacy.example.com', 22, 'ops', 'password', 'legacy-ciphertext',
        1, 'legacy-group', '{"keepaliveIntervalMs":12000,"keepaliveCountMax":7,"reconnect":{"enabled":true,"maxAttempts":2,"baseDelayMs":300,"maxDelayMs":2000}}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);
    legacyDatabase.close();

    try {
      runtime = createWindowsLocalRuntime({ dataDir });
      await request(runtime, 'migration-setup', 'vault.setup', { masterPassword: 'migration-password' });
      const hosts = await request(runtime, 'migration-host-list', 'hosts.list', {}) as Array<Record<string, unknown>>;
      expect(hosts).toHaveLength(1);
      expect(hosts[0]).toMatchObject({
        id: 'legacy-host',
        name: 'Legacy host',
        groupId: 'legacy-group',
        connectionProfileOverrides: {
          keepaliveIntervalMs: 12_000,
          keepaliveCountMax: 7,
          reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 2_000 }
        },
        resolvedConnectionProfile: {
          keepaliveIntervalMs: 12_000,
          keepaliveCountMax: 7,
          reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 2_000 }
        }
      });
    } finally {
      await runtime?.close();
      runtime = undefined;
      await rm(dataDir, { recursive: true, force: true });
    }
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

  it('passes the stored private-key credential to the native SSH adapter', async () => {
    let capturedAuth: unknown;
    const channel = new EventEmitter() as SshChannel & EventEmitter;
    channel.write = () => undefined;
    channel.resize = () => undefined;
    channel.close = () => { channel.emit('close'); };
    const sshAdapter: SshAdapterPort = {
      async connect(config, callbacks) {
        capturedAuth = config.auth;
        callbacks.onStatus?.('connected');
        return channel;
      },
      async testConnection() { return { ok: true }; }
    };
    runtime = createWindowsLocalRuntime({ dataDir: ':memory:', sshAdapter });
    await request(runtime, 'private-key-setup', 'vault.setup', { masterPassword: 'test-password' });
    const privateKey = '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture-only\n-----END OPENSSH PRIVATE KEY-----';
    const host = await request(runtime, 'private-key-host', 'hosts.create', {
      input: {
        name: 'Private Key Host',
        address: 'private-key.example.com',
        port: 22,
        username: 'ops',
        auth: { type: 'private_key', privateKey, passphrase: 'fixture-passphrase' }
      }
    }) as { id: string };

    await expect(request(runtime, 'private-key-open', 'sessions.openShell', {
      request: { requestId: 'private-key-session', hostId: host.id, cols: 80, rows: 24 }
    })).resolves.toMatchObject({ sessionId: 'private-key-session', hostId: host.id });
    expect(capturedAuth).toEqual({ type: 'private_key', privateKey, passphrase: 'fixture-passphrase' });
    await request(runtime, 'private-key-close', 'sessions.close', { sessionId: 'private-key-session' });
  });

  it('does not silently accept a changed trusted host key', async () => {
    let connectionCount = 0;
    let hostId = '';
    const events: Array<{ kind: string; payload: unknown }> = [];
    const makeChannel = (): SshChannel & EventEmitter => {
      const channel = new EventEmitter() as SshChannel & EventEmitter;
      channel.write = () => undefined;
      channel.resize = () => undefined;
      channel.close = () => { channel.emit('close'); };
      return channel;
    };
    const sshAdapter: SshAdapterPort = {
      async connect(_config, callbacks) {
        connectionCount += 1;
        const changed = connectionCount > 1;
        const accepted = await callbacks.onHostKey({
          algorithm: 'ssh-ed25519',
          fingerprint: changed ? 'SHA256:changed' : 'SHA256:first',
          address: 'changed-key.example.com',
          port: 22,
          hostId: hostId,
          reason: changed ? 'changed' : 'first-seen'
        });
        if (!accepted) throw new Error('host key rejected');
        callbacks.onStatus?.('connected');
        return makeChannel();
      },
      async testConnection() { return { ok: true }; }
    };
    runtime = createWindowsLocalRuntime({ dataDir: ':memory:', sshAdapter });
    runtime.subscribe((event) => events.push({ kind: event.kind, payload: event.payload }));
    await request(runtime, 'changed-key-setup', 'vault.setup', { masterPassword: 'test-password' });
    const host = await request(runtime, 'changed-key-host', 'hosts.create', {
      input: { name: 'Changed Key Host', address: 'changed-key.example.com', port: 22, username: 'ops', auth: { type: 'password', password: 'fixture-password' } }
    }) as { id: string };
    hostId = host.id;

    const firstOpen = runtime.router.dispatch({
      version: 1,
      requestId: 'changed-key-first-session',
      operation: 'sessions.openShell',
      payload: { request: { requestId: 'changed-key-first-session', hostId: host.id, cols: 80, rows: 24 } }
    });
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'terminal.host-key' && (event.payload as { reason?: string }).reason === 'first-seen')).toBe(true));
    await expect(request(runtime, 'changed-key-trust', 'sessions.hostKeyDecision', { sessionId: 'changed-key-first-session', decision: 'trust', fingerprint: 'SHA256:first' })).resolves.toMatchObject({ accepted: true });
    await expect(firstOpen).resolves.toMatchObject({ ok: true, result: { sessionId: 'changed-key-first-session' } });
    await request(runtime, 'changed-key-close-first', 'sessions.close', { sessionId: 'changed-key-first-session' });

    const secondOpen = runtime.router.dispatch({
      version: 1,
      requestId: 'changed-key-second-session',
      operation: 'sessions.openShell',
      payload: { request: { requestId: 'changed-key-second-session', hostId: host.id, cols: 80, rows: 24 } }
    });
    await vi.waitFor(() => expect(events.some((event) => event.kind === 'terminal.host-key' && (event.payload as { reason?: string }).reason === 'changed')).toBe(true));
    const changedChallenge = events.find((event) => event.kind === 'terminal.host-key' && (event.payload as { reason?: string }).reason === 'changed');
    expect(changedChallenge?.payload).toMatchObject({ fingerprint: 'SHA256:changed', previous: { fingerprint: 'SHA256:first' } });
    await expect(request(runtime, 'changed-key-reject', 'sessions.hostKeyDecision', { sessionId: 'changed-key-second-session', decision: 'reject', fingerprint: 'SHA256:changed' })).resolves.toMatchObject({ accepted: false });
    await expect(secondOpen).resolves.toMatchObject({ ok: false, error: { code: 'HOST_KEY_MISMATCH' } });
    expect(events).toContainEqual(expect.objectContaining({ kind: 'terminal.error', payload: expect.objectContaining({ code: 'HOST_KEY_MISMATCH' }) }));
    expect(connectionCount).toBe(2);
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

  it('keeps native file selection and desktop notifications behind bounded IPC', async () => {
    const source = {
      name: 'selected.bin',
      size: 3,
      stream: vi.fn(async function* () { yield new Uint8Array([1, 2, 3]); }),
      close: vi.fn(async () => undefined)
    };
    const open = vi.fn(async () => source);
    const notifications = {
      permission: vi.fn(async () => 'granted' as const),
      requestPermission: vi.fn(async () => 'granted' as const),
      notify: vi.fn(async (_request: { title: string; body: string; tag?: string }) => undefined)
    };
    runtime = createWindowsLocalRuntime({ dataDir: ':memory:', systemServices: { fileOpen: { open }, notifications } });
    await request(runtime, 'setup-native-services', 'vault.setup', { masterPassword: 'test-password' });

    const opened = await request(runtime, 'source-open', 'system.fileOpen.open', {}) as { sourceId: string; name: string; size: number };
    expect(opened).toMatchObject({ name: 'selected.bin', size: 3 });
    await request(runtime, 'source-release', 'files.releaseUploadSource', { sourceId: opened.sourceId });
    await expect(request(runtime, 'source-release-again', 'files.releaseUploadSource', { sourceId: opened.sourceId })).resolves.toBeUndefined();

    await expect(request(runtime, 'notification-permission', 'system.notifications.permission', {})).resolves.toEqual({ permission: 'granted' });
    await expect(request(runtime, 'notification-request', 'system.notifications.requestPermission', {})).resolves.toEqual({ permission: 'granted' });
    await request(runtime, 'notification-send', 'system.notifications.notify', { title: 'Relay', body: '完成', tag: 'task-1' });

    expect(open).toHaveBeenCalledOnce();
    expect(source.close).toHaveBeenCalledOnce();
    expect(notifications.permission).toHaveBeenCalledOnce();
    expect(notifications.requestPermission).toHaveBeenCalledOnce();
    expect(notifications.notify).toHaveBeenCalledWith({ title: 'Relay', body: '完成', tag: 'task-1' });
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

  it('round-trips a chunked Windows export through a second local runtime', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'relay-windows-bundle-source-'));
    const targetDir = await mkdtemp(join(tmpdir(), 'relay-windows-bundle-target-'));
    let source: WindowsLocalRuntimeHandle | undefined;
    let target: WindowsLocalRuntimeHandle | undefined;
    try {
      source = createWindowsLocalRuntime({ dataDir: sourceDir });
      await request(source, 'roundtrip-source-setup', 'vault.setup', { masterPassword: 'source-password' });
      await request(source, 'roundtrip-source-host', 'hosts.create', {
        input: { name: 'Chunk roundtrip host', address: 'roundtrip.example.com', port: 22, username: 'ops', auth: { type: 'password', password: 'roundtrip-secret' } }
      });

      const started = await request(source, 'roundtrip-export', 'imports.exportVaultBundle', { exportPassword: 'export-password' }) as { bundleId: string };
      const chunks: string[] = [];
      let cursor = 0;
      for (;;) {
        const part = await request(source, `roundtrip-read-${cursor}`, 'imports.readVaultBundleChunk', { bundleId: started.bundleId, cursor }) as { data: string; nextCursor: number; done: boolean };
        chunks.push(Buffer.from(part.data, 'base64url').toString('utf8'));
        if (part.done) break;
        cursor = part.nextCursor;
      }
      const bundle = chunks.join('');
      await request(source, 'roundtrip-release', 'imports.releaseVaultBundle', { bundleId: started.bundleId });

      target = createWindowsLocalRuntime({ dataDir: targetDir });
      await request(target, 'roundtrip-target-setup', 'vault.setup', { masterPassword: 'target-password' });
      const preview = await request(target, 'roundtrip-preview', 'imports.previewVaultImport', { exportPassword: 'export-password', bundle }) as { previewId: string; hostCount: number; conflicts: unknown[] };
      expect(preview).toMatchObject({ hostCount: 1, conflicts: [] });
      await request(target, 'roundtrip-apply', 'imports.applyVaultImport', {
        previewId: preview.previewId,
        resolution: { hostConflicts: 'skip', groupConflicts: 'reuse', identityConflicts: 'reuse' }
      });
      await expect(request(target, 'roundtrip-host-list', 'hosts.list', {})).resolves.toEqual([
        expect.objectContaining({ name: 'Chunk roundtrip host', address: 'roundtrip.example.com', username: 'ops' })
      ]);
    } finally {
      await source?.close();
      await target?.close();
      await rm(sourceDir, { recursive: true, force: true });
      await rm(targetDir, { recursive: true, force: true });
    }
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
