import { describe, expect, it, vi } from 'vitest';

import { assertCoreRuntimeContract } from '../../fixtures/core-runtime-contract.js';
import type { TransferResumeRequest } from '../../../src/shared/core/models.js';
import type { HostMetadata } from '../../../src/shared/validation.js';
import { createWebAdapters, WebCommandTransport, WebFileTransport, WebHostStore, WebImportExportAdapter, WebSecretStore, WebSessionTransport } from '../../../src/web/platform/web-adapters.js';
import type { TerminalSocketLike } from '../../../src/web/hooks/use-terminal-session.js';

const host: HostMetadata = {
  id: 'host-1', name: 'Fixture', address: '10.0.0.8', port: 22, username: 'deploy', authType: 'password', groupId: null, tags: [], isFavorite: false, hostKeyAlgorithm: null, hostKeyFingerprint: null, lastConnectedAt: null, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z'
};

const createIdleSocket = (): TerminalSocketLike => ({
  readyState: 0,
  onopen: null,
  onmessage: null,
  onerror: null,
  onclose: null,
  send() {},
  close() {}
});

const createWebContractApi = () => {
  const transfer = {
    id: 'transfer-1',
    kind: 'download' as const,
    hostId: 'host-1',
    sourcePath: '/source',
    targetPath: 'target',
    status: 'queued' as const,
    completedBytes: 0,
    totalBytes: null,
    createdAt: '',
    updatedAt: ''
  };
  const commandRun = {
    id: 'run-1',
    command: 'uname -a',
    hostIds: ['host-1', 'host-2'],
    persistOutput: false,
    status: 'queued' as const,
    targets: ['host-1', 'host-2'].map((hostId) => ({ hostId, status: 'queued' as const, exitCode: null, output: '', outputBytes: 0 })),
    createdAt: ''
  };
  return {
    getCapabilities: async () => ({ client: 'web' as const, version: 1 as const, capabilities: ['workspace.persistence'] as const }),
    getSetupStatus: async () => ({ initialized: true, locked: false }),
    testConnection: async () => ({ ok: true }),
    getWorkspace: async () => ({ version: 0, tabs: [], activeTabId: null, layout: { mode: 'single' as const, ratio: 0.5 }, filters: { query: '', groupId: null, favoriteOnly: false } }),
    listHosts: async () => [host],
    getHost: async () => host,
    listIdentities: async () => [],
    listGroups: async () => [],
    listSnippets: async () => [],
    listAuditEvents: async () => ({ items: [] }),
    listSftpEntries: async () => [],
    mutateSftpEntry: async () => {},
    createTransfer: async () => transfer,
    getTransfer: async () => transfer,
    uploadTransferContent: async () => ({ ...transfer, kind: 'upload' as const, status: 'completed' as const, completedBytes: 2, totalBytes: 2 }),
    uploadTransferChunk: async () => ({ ...transfer, kind: 'upload' as const, status: 'completed' as const, completedBytes: 2, totalBytes: 2 }),
    downloadTransferContent: async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x6f]));
        controller.enqueue(new Uint8Array([0x6b]));
        controller.close();
      }
    }),
    cancelTransfer: async () => {},
    retryTransfer: async () => transfer,
    startCommandRun: async () => commandRun,
    getCommandRun: async () => commandRun,
    cancelCommandRun: async () => {},
    previewExternalImport: async () => ({
      previewId: 'preview-1',
      source: { filename: 'config', format: 'openssh-config' as const },
      sources: [{ filename: 'config', format: 'openssh-config' as const }],
      connectionCount: 0,
      groupCount: 0,
      connections: [],
      conflicts: [],
      warnings: [],
      expiresAt: ''
    }),
    applyExternalImport: async () => ({ importedHosts: 0, skippedHosts: 0, importedGroups: 0, skippedGroups: 0, warnings: [] }),
    exportOpenSshConfig: async () => new Blob(['Host app']),
    exportSshCsv: async () => new Blob(['name,address']),
    exportVaultBundle: async () => ({ bundle: 'web-vault-bundle' }),
    previewVaultImport: async () => ({ previewId: 'preview-1', hostCount: 0, groupCount: 0, conflicts: [], expiresAt: '' }),
    applyVaultImport: async () => ({ importedHosts: 0, skippedHosts: 0, importedGroups: 0, skippedGroups: 0 })
  };
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
      mutateSftpEntry: vi.fn(async () => {}),
      createTransfer: vi.fn(async () => ({ id: 'transfer-1', kind: 'download' as const, hostId: 'host-1', sourcePath: '/source', targetPath: 'target', status: 'queued' as const, completedBytes: 0, totalBytes: null, createdAt: '', updatedAt: '' })),
      getTransfer: vi.fn(async (id: string) => ({ id, kind: 'download' as const, hostId: 'host-1', sourcePath: '/source', targetPath: 'target', status: 'queued' as const, completedBytes: 0, totalBytes: null, createdAt: '', updatedAt: '' })),
      uploadTransferContent: vi.fn(async () => ({ id: 'transfer-1', kind: 'upload' as const, hostId: 'host-1', sourcePath: 'source', targetPath: '/target', status: 'completed' as const, completedBytes: 1, totalBytes: 1, createdAt: '', updatedAt: '' })),
      uploadTransferChunk: vi.fn(async (_id: string, _chunk: Blob, _resume: unknown, _nextChecksum: string, _final: boolean) => ({ id: 'transfer-1', kind: 'upload' as const, hostId: 'host-1', sourcePath: 'source', targetPath: '/target', status: 'completed' as const, completedBytes: 3, totalBytes: 3, createdAt: '', updatedAt: '' })),
      downloadTransferContent: vi.fn(async () => new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([99, 111]));
          controller.enqueue(new Uint8Array([110, 116, 101, 110, 116]));
          controller.close();
        }
      })),
      cancelTransfer: vi.fn(async () => {}),
      retryTransfer: vi.fn(async () => ({ id: 'transfer-1', kind: 'download' as const, hostId: 'host-1', sourcePath: '/source', targetPath: 'target', status: 'queued' as const, completedBytes: 0, totalBytes: null, createdAt: '', updatedAt: '' })),
      startCommandRun: vi.fn(async (request) => ({ id: 'run-1', command: request.command, hostIds: request.hostIds, persistOutput: request.persistOutput, status: 'queued' as const, targets: request.hostIds.map((hostId) => ({ hostId, status: 'queued' as const, exitCode: null, output: '', outputBytes: 0 })), createdAt: '' })),
      getCommandRun: vi.fn(async () => null),
      cancelCommandRun: vi.fn(async () => {})
    };
    const files = new WebFileTransport(api);
    await files.list('host-1', '/');
    await files.createTransfer({ kind: 'download', hostId: 'host-1', sourcePath: '/source', targetPath: 'target' });
    await files.getTransfer('transfer-1');
    await files.createDirectory('host-1', '/tmp/new');
    await files.rename('host-1', '/tmp/new', '/tmp/renamed');
    await files.remove('host-1', '/tmp/renamed');
    await files.upload('transfer-1', { name: 'source', size: 3, async *stream() { yield new Uint8Array([1, 2, 3]); } }, { transferId: 'transfer-1', expectedOffset: 0, checksum: null });
    const downloaded: Uint8Array[] = [];
    for await (const chunk of await files.download('transfer-1')) downloaded.push(chunk);
    await files.cancelTransfer('transfer-1');
    await files.retryTransfer('transfer-1');
    expect(api.listSftpEntries).toHaveBeenCalledWith('host-1', '/');
    expect(api.getTransfer).toHaveBeenCalledWith('transfer-1');
    expect(api.mutateSftpEntry).toHaveBeenCalledWith('host-1', { action: 'mkdir', path: '/tmp/new' });
    expect(api.mutateSftpEntry).toHaveBeenCalledWith('host-1', { action: 'rename', from: '/tmp/new', to: '/tmp/renamed' });
    expect(api.mutateSftpEntry).toHaveBeenCalledWith('host-1', { action: 'delete', path: '/tmp/renamed', confirmed: true });
    const uploadCall = api.uploadTransferChunk.mock.calls[0];
    expect(uploadCall?.[0]).toBe('transfer-1');
    expect(uploadCall?.[1]).toBeInstanceOf(Blob);
    expect(await uploadCall?.[1].text()).toBe('\x01\x02\x03');
    expect(uploadCall?.[2]).toEqual({ transferId: 'transfer-1', expectedOffset: 0, checksum: null });
    expect(uploadCall?.[3]).toBe('039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81');
    expect(uploadCall?.[4]).toBe(true);
    expect(downloaded).toEqual([new Uint8Array([99, 111]), new Uint8Array([110, 116, 101, 110, 116])]);
    expect(api.cancelTransfer).toHaveBeenCalledWith('transfer-1');
    expect(api.retryTransfer).toHaveBeenCalledWith('transfer-1');

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

  it('splits browser uploads into bounded chunks while carrying the incremental checkpoint checksum', async () => {
    const totalBytes = 1024 * 1024 + 3;
    const data = new Uint8Array(totalBytes);
    data.fill(7);
    const calls: Array<{ size: number; offset: number; checksum: string | null; nextChecksum: string; final: boolean }> = [];
    const api = {
      listSftpEntries: vi.fn(async () => []),
      createTransfer: vi.fn(async () => ({ id: 'transfer-large', kind: 'upload' as const, hostId: 'host-1', sourcePath: 'source', targetPath: '/target', status: 'queued' as const, completedBytes: 0, totalBytes, createdAt: '', updatedAt: '' })),
      cancelTransfer: vi.fn(async () => {}),
      uploadTransferChunk: vi.fn(async (_id: string, chunk: Blob, resume: TransferResumeRequest, nextChecksum: string, final: boolean) => {
        calls.push({ size: chunk.size, offset: resume.expectedOffset, checksum: resume.checksum, nextChecksum, final });
        const offset = resume.expectedOffset + chunk.size;
        return {
          id: 'transfer-large', kind: 'upload' as const, hostId: 'host-1', sourcePath: 'source', targetPath: '/target',
          status: final ? 'completed' as const : 'running' as const, completedBytes: offset, totalBytes,
          checkpoint: { transferId: 'transfer-large', offset, totalBytes, checksum: nextChecksum }, createdAt: '', updatedAt: ''
        };
      })
    };

    const files = new WebFileTransport(api);
    const completed = await files.upload('transfer-large', { name: 'source', size: totalBytes, async *stream() { yield data; } });

    expect(completed.status).toBe('completed');
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ size: 1024 * 1024, offset: 0, checksum: null, final: false });
    expect(calls[1]).toMatchObject({ size: 3, offset: 1024 * 1024, checksum: calls[0]?.nextChecksum, final: true });
  });

  it('composes the full platform-neutral runtime at the Web boundary', async () => {
    const runtime = createWebAdapters({ api: createWebContractApi(), webSocketFactory: createIdleSocket });
    await assertCoreRuntimeContract(runtime, { platform: 'web' });
    expect(runtime.platform).toBe('web');
    expect(runtime.capabilities.supports('workspace.persistence')).toBe(true);
    expect(runtime.vault).toBeDefined();
    expect(runtime.connection).toBeDefined();
    expect(runtime.hosts).toBeDefined();
    expect(runtime.identities).toBeDefined();
    expect(runtime.groups).toBeDefined();
    expect(runtime.workspace).toBeDefined();
    expect(runtime.secrets).toBeDefined();
    expect(runtime.sessions).toBeDefined();
    expect(runtime.files).toBeDefined();
    expect(runtime.commands).toBeDefined();
    expect(runtime.snippets).toBeDefined();
    expect(runtime.activity).toBeDefined();
    expect(runtime.imports).toBeDefined();
    await expect(runtime.refreshCapabilities()).resolves.toEqual(expect.objectContaining({ capabilities: ['workspace.persistence'] }));
    expect(runtime.capabilities.supports('workspace.persistence')).toBe(true);
    expect(runtime.capabilities.supports('workspace.multi-pane')).toBe(false);
  });

  it('intersects a server pane limit with the Web platform upper bound', async () => {
    const runtime = createWebAdapters({
      api: {
        getCapabilities: async () => ({
          client: 'web' as const,
          version: 1 as const,
          capabilities: ['workspace.max-panes'] as const,
          limits: { maxWorkspacePanes: 16 }
        })
      }
    });

    await runtime.refreshCapabilities();
    expect(runtime.capabilities.limits.maxWorkspacePanes).toBe(4);
    expect(runtime.capabilities.supports('workspace.max-panes')).toBe(true);
  });

  it('keeps cross-product import/export behind the shared imports port', async () => {
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
    const imports = new WebImportExportAdapter(api);
    await imports.previewExternalImport([{ filename: 'config', content: 'Host app' }], 'openssh-config');
    await imports.applyExternalImport('preview-1', { selectedSourceIds: [], conflictPolicy: 'skip' });
    await imports.exportOpenSshConfig();
    await imports.exportCsv();
    expect(api.previewExternalImport).toHaveBeenCalledWith([expect.any(File)], 'openssh-config');
    expect(api.applyExternalImport).toHaveBeenCalledWith('preview-1', { selectedSourceIds: [], conflictPolicy: 'skip' });
    expect(api.exportSshCsv).toHaveBeenCalledWith(undefined);
  });
});
