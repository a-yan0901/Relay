import { createCapabilitySet } from '../../src/shared/core/capabilities.js';
import type {
  Capability,
  ClientPlatform,
  CommandRun,
  CommandRunRequest,
  ConnectionProfile,
  GroupNode,
  IdentityMetadata,
  SftpEntry,
  TransferJob,
  TransferRequest,
  WorkspaceState
} from '../../src/shared/core/models.js';
import type { CoreRuntime } from '../../src/shared/core/runtime.js';
import type { BinarySource, CommandTransport, FileTransport, SessionHandle, SessionTransport } from '../../src/shared/core/ports.js';

const emptyWorkspace = (): WorkspaceState => ({
  version: 0,
  tabs: [],
  activeTabId: null,
  layout: { mode: 'single', ratio: 0.5 },
  filters: { query: '', groupId: null, favoriteOnly: false }
});

const createSessionHandle = (sessionId: string, hostId: string): SessionHandle => ({
  id: sessionId,
  hostId,
  write() {},
  resize() {},
  close() {},
  subscribe() { return () => {}; }
});

const createTransferJob = (id: string, request: TransferRequest): TransferJob => ({
  id,
  kind: request.kind,
  hostId: request.hostId,
  sourcePath: request.sourcePath,
  targetPath: request.targetPath,
  status: 'queued',
  completedBytes: 0,
  totalBytes: request.totalBytes ?? null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString()
});

const createCommandRun = (id: string, request: CommandRunRequest): CommandRun => ({
  id,
  command: request.command,
  hostIds: request.hostIds,
  persistOutput: request.persistOutput,
  status: 'queued',
  targets: request.hostIds.map((hostId) => ({
    hostId,
    status: 'queued',
    exitCode: null,
    output: '',
    outputBytes: 0
  })),
  createdAt: new Date().toISOString()
});

const createSessionTransport = (): SessionTransport => {
  const sessions = new Map<string, SessionHandle>();
  return {
    async openShell(request) {
      const handle = createSessionHandle(request.sessionId, request.profile.hostId);
      sessions.set(handle.id, handle);
      return handle;
    },
    async reconnect(sessionId) {
      const handle = sessions.get(sessionId);
      if (!handle) throw new Error('session not found');
      return handle;
    },
    async close(sessionId) {
      sessions.delete(sessionId);
    }
  };
};

const createFileTransport = (): FileTransport => {
  const transfers = new Map<string, TransferJob>();
  return {
    async list(_hostId: string, _path: string): Promise<readonly SftpEntry[]> {
      return [];
    },
    async createDirectory() {},
    async rename() {},
    async remove() {},
    async createTransfer(request) {
      const job = createTransferJob(`transfer-${transfers.size + 1}`, request);
      transfers.set(job.id, job);
      return job;
    },
    async listTransfers() {
      return [...transfers.values()];
    },
    async getTransfer(id) {
      return transfers.get(id) ?? null;
    },
    async upload(id, source: BinarySource) {
      let completedBytes = 0;
      for await (const chunk of source.stream()) completedBytes += chunk.byteLength;
      const current = transfers.get(id) ?? createTransferJob(id, {
        kind: 'upload',
        hostId: 'host-1',
        sourcePath: source.name,
        targetPath: source.name,
        totalBytes: source.size
      });
      const job = { ...current, status: 'completed' as const, completedBytes, totalBytes: source.size ?? current.totalBytes };
      transfers.set(id, job);
      return job;
    },
    async download() {
      return (async function* () {
        yield new Uint8Array([0x6f, 0x6b]);
      })();
    },
    async cancelTransfer(id) {
      const current = transfers.get(id);
      if (current) transfers.set(id, { ...current, status: 'cancelled' });
    },
    async retryTransfer(id) {
      const current = transfers.get(id);
      if (!current) throw new Error('transfer not found');
      const job = { ...current, status: 'queued' as const, completedBytes: 0 };
      transfers.set(id, job);
      return job;
    }
  };
};

const createCommandTransport = (): CommandTransport => {
  const runs = new Map<string, CommandRun>();
  return {
    async start(request) {
      const run = createCommandRun(`run-${runs.size + 1}`, request);
      runs.set(run.id, run);
      return run;
    },
    async get(id) {
      return runs.get(id) ?? null;
    },
    async cancel(id) {
      const current = runs.get(id);
      if (current) runs.set(id, {
        ...current,
        status: 'cancelled',
        targets: current.targets.map((target) => ({ ...target, status: 'cancelled' }))
      });
    }
  };
};

const NATIVE_CAPABILITIES: readonly Capability[] = [
  'workspace.persistence',
  'workspace.templates',
  'workspace.multi-pane',
  'vault.bundle',
  'vault.identities',
  'ssh.shell',
  'ssh.reconnect',
  'ssh.proxy-jump',
  'sftp.browse',
  'sftp.transfer',
  'sftp.entry-mutations',
  'automation.snippets',
  'automation.snippet-manager',
  'automation.batch-exec',
  'automation.target-picker',
  'audit.activity',
  'session.lifecycle-status'
];

export const createInMemoryCoreRuntime = (
  platform: ClientPlatform,
  supportedCapabilities: readonly Capability[] = NATIVE_CAPABILITIES
): CoreRuntime => {
  const capabilities = createCapabilitySet(platform, supportedCapabilities);
  const workspace = emptyWorkspace();
  const sessions = createSessionTransport();
  const files = createFileTransport();
  const commands = createCommandTransport();
  const runtime: CoreRuntime = {
    platform,
    capabilities,
    async negotiateCapabilities() {
      return runtime.capabilities;
    },
    vault: {
      async status() { return { phase: 'unlocked' }; },
      async setup() { return { phase: 'unlocked' }; },
      async unlock() { return { phase: 'unlocked' }; },
      async lock() {}
    },
    connection: {
      async test() { return { ok: true }; }
    },
    hosts: {
      async list() { return []; },
      async get() { return null; },
      async listProfiles(): Promise<readonly ConnectionProfile[]> { return []; },
      async getProfile() { return null; },
      async create() { throw new Error('unused'); },
      async update() { throw new Error('unused'); },
      async delete() {}
    },
    identities: {
      async list(): Promise<readonly IdentityMetadata[]> { return []; },
      async get() { return null; },
      async create() { throw new Error('unused'); },
      async update() { throw new Error('unused'); },
      async delete() {}
    },
    groups: {
      async list(): Promise<readonly GroupNode[]> { return []; },
      async get() { return null; },
      async create() { throw new Error('unused'); },
      async update() { throw new Error('unused'); },
      async delete() {}
    },
    workspace: {
      async load() { return workspace; },
      async save(_expectedVersion, state) { return state; },
      async listTemplates() { return []; },
      async createTemplate() { throw new Error('unused'); },
      async deleteTemplate() {}
    },
    secrets: {
      async get() { return null; },
      async set() {},
      async remove() {}
    },
    sessions,
    files,
    commands,
    snippets: {
      async list() { return []; },
      async get() { return null; },
      async create() { throw new Error('unused'); },
      async update() { throw new Error('unused'); },
      async delete() {}
    },
    activity: {
      async list() { return []; }
    },
    imports: {
      async previewExternalImport() { throw new Error('unused'); },
      async applyExternalImport() { throw new Error('unused'); },
      async exportOpenSshConfig() { return new Uint8Array([0x48, 0x6f, 0x73, 0x74]); },
      async exportCsv() { return new Uint8Array([0x6e, 0x61, 0x6d, 0x65]); },
      async exportVaultBundle() { return 'native-vault-bundle'; },
      async previewVaultImport() { throw new Error('unused'); },
      async applyVaultImport() { throw new Error('unused'); }
    }
  };
  return runtime;
};

export const createNativeLikeRuntime = (platform: Extract<ClientPlatform, 'desktop' | 'android'>): CoreRuntime => (
  createInMemoryCoreRuntime(platform)
);
