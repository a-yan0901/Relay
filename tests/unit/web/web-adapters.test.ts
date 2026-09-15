import { describe, expect, it, vi } from 'vitest';

import type { HostMetadata } from '../../../src/shared/validation.js';
import { createWebAdapters, WebCommandTransport, WebFileTransport, WebHostStore, WebSecretStore, WebSessionTransport } from '../../../src/web/platform/web-adapters.js';
import type { TerminalSocketLike } from '../../../src/web/hooks/use-terminal-session.js';

const host: HostMetadata = {
  id: 'host-1', name: 'Fixture', address: '10.0.0.8', port: 22, username: 'deploy', authType: 'password', groupId: null, tags: [], isFavorite: false, hostKeyAlgorithm: null, hostKeyFingerprint: null, lastConnectedAt: null, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z'
};

describe('web adapters', () => {
  it('keeps WebSocket lifecycle behind the SessionTransport port', async () => {
    const makeSocket = (): TerminalSocketLike => ({
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: vi.fn(),
      close: vi.fn()
    });
    const sockets = [makeSocket(), makeSocket()];
    const factory = vi.fn(() => sockets.shift() ?? makeSocket());
    const transport = new WebSessionTransport({ webSocketFactory: factory });
    const profile = {
      hostId: 'host-1', address: '10.0.0.8', port: 22, username: 'deploy', authType: 'password' as const,
      jumpHostIds: [], keepaliveIntervalMs: 10_000, keepaliveCountMax: 3,
      reconnect: { enabled: true, maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
      hostKeyAlgorithm: null, hostKeyFingerprint: null
    };

    const handle = await transport.openShell({ sessionId: 'session-1', profile, cols: 80, rows: 24 });
    expect(factory).toHaveBeenCalledWith('ws://localhost/ws/terminal');
    const firstSocket = factory.mock.results[0]?.value as TerminalSocketLike;
    firstSocket.readyState = 1;
    firstSocket.onopen?.();
    expect(firstSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"open"'));

    const reconnected = await transport.reconnect('session-1');
    expect(reconnected).toBe(handle);
    const secondSocket = factory.mock.results[1]?.value as TerminalSocketLike;
    secondSocket.readyState = 1;
    secondSocket.onopen?.();
    await transport.close('session-1');
    expect(secondSocket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'close' }));
    expect(secondSocket.close).toHaveBeenCalledWith(1000, 'terminal closed');
  });

  it('keeps file and command HTTP operations behind shared ports', async () => {
    const api = {
      listSftpEntries: vi.fn(async () => []),
      createTransfer: vi.fn(async () => ({ id: 'transfer-1', kind: 'download' as const, hostId: 'host-1', sourcePath: '/source', targetPath: 'target', status: 'queued' as const, completedBytes: 0, totalBytes: null, createdAt: '', updatedAt: '' })),
      cancelTransfer: vi.fn(async () => {}),
      startCommandRun: vi.fn(async (request) => ({ id: 'run-1', command: request.command, hostIds: request.hostIds, persistOutput: request.persistOutput, status: 'queued' as const, targets: request.hostIds.map((hostId) => ({ hostId, status: 'queued' as const, exitCode: null, output: '', outputBytes: 0 })), createdAt: '' })),
      getCommandRun: vi.fn(async () => null),
      cancelCommandRun: vi.fn(async () => {})
    };
    const files = new WebFileTransport(api);
    await files.list('host-1', '/');
    await files.createTransfer({ kind: 'download', hostId: 'host-1', sourcePath: '/source', targetPath: 'target' });
    await files.cancelTransfer('transfer-1');
    expect(api.listSftpEntries).toHaveBeenCalledWith('host-1', '/');
    expect(api.cancelTransfer).toHaveBeenCalledWith('transfer-1');

    const commands = new WebCommandTransport(api);
    const run = await commands.start({ command: 'id', hostIds: ['host-1'], variables: {}, concurrency: 1, timeoutMs: 1_000, persistOutput: false, confirmed: true });
    await commands.get(run.id);
    await commands.cancel(run.id);
    expect(api.startCommandRun).toHaveBeenCalled();
    expect(api.cancelCommandRun).toHaveBeenCalledWith('run-1');
  });

  it('maps host metadata to shared connection profiles and never persists Web secrets', async () => {
    const hosts = new WebHostStore({ listHosts: vi.fn(async () => [host]), getHost: vi.fn(async () => host) });
    const profile = await hosts.getProfile('host-1');
    expect(profile).toEqual(expect.objectContaining({ hostId: 'host-1', address: '10.0.0.8', authType: 'password', jumpHostIds: [] }));
    const secretStore = new WebSecretStore();
    await expect(secretStore.get('host-1')).resolves.toBeNull();
    await expect(secretStore.set('host-1', 'secret')).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
    expect(createWebAdapters({ api: { listHosts: async () => [], getHost: async () => null } })).toHaveProperty('sessions');
  });

  it('keeps cross-product import/export behind the workspace adapter', async () => {
    const externalPreview = {
      previewId: 'preview-1',
      source: { filename: 'config', format: 'openssh-config' as const },
      sources: [{ filename: 'config', format: 'openssh-config' as const }],
      connectionCount: 0,
      groupCount: 0,
      connections: [],
      conflicts: [],
      warnings: [],
      expiresAt: ''
    };
    const api = {
      previewExternalImport: vi.fn(async () => externalPreview),
      applyExternalImport: vi.fn(async () => ({ importedHosts: 1, skippedHosts: 0, importedGroups: 0, skippedGroups: 0, warnings: [] })),
      exportOpenSshConfig: vi.fn(async () => new Blob(['Host app'])),
      exportSshCsv: vi.fn(async () => new Blob(['name,address']))
    };
    const workspace = createWebAdapters({ api }).workspace;
    const file = new File(['Host app'], 'config');
    await workspace.previewExternalImport([file], 'openssh-config');
    await workspace.applyExternalImport('preview-1', { selectedSourceIds: [], conflictPolicy: 'skip' });
    await workspace.exportOpenSshConfig();
    await workspace.exportCsv();
    expect(api.previewExternalImport).toHaveBeenCalledWith([file], 'openssh-config');
    expect(api.applyExternalImport).toHaveBeenCalledWith('preview-1', { selectedSourceIds: [], conflictPolicy: 'skip' });
    expect(api.exportSshCsv).toHaveBeenCalledWith(undefined);
  });
});
