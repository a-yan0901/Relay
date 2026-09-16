import { createCapabilitySet } from '../../src/shared/core/capabilities.js';
import type {
  AccountSession,
  Capability,
  ClientPlatform,
  CommandRun,
  CommandRunRequest,
  ConnectionProfile,
  GroupNode,
  IdentityMetadata,
  RecoveryKeyState,
  SftpEntry,
  SyncConflictExport,
  SyncDescriptor,
  SyncEnvelope,
  SyncHead,
  SyncPreview,
  SyncState,
  TransferJob,
  TransferRequest,
  WorkspaceState
} from '../../src/shared/core/models.js';
import type { CoreRuntime } from '../../src/shared/core/runtime.js';
import type {
  AccountSessionPort,
  BinarySource,
  CommandTransport,
  DeviceTrustPort,
  FileTransport,
  RecoveryKeyReveal,
  SessionHandle,
  SessionTransport,
  SyncPort
} from '../../src/shared/core/ports.js';

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
    async pauseTransfer(id) {
      const current = transfers.get(id);
      if (current && (current.status === 'queued' || current.status === 'running')) transfers.set(id, { ...current, status: 'paused' });
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

export interface InMemoryCoreRuntimeOptions {
  account?: AccountSessionPort;
  devices?: DeviceTrustPort;
  sync?: SyncPort;
}

export interface InMemoryAccountSyncPorts {
  account: AccountSessionPort;
  devices: DeviceTrustPort;
  sync: SyncPort;
}

const CONTRACT_ACCOUNT_ID = 'account-contract';
const CONTRACT_DEVICE_ID = 'device-contract-current';
const CONTRACT_SECONDARY_DEVICE_ID = 'device-contract-secondary';
const CONTRACT_VAULT_ID = 'vault-contract';
const CONTRACT_TIMESTAMP = '2026-09-16T00:00:00.000Z';

const createOpaqueEnvelope = (deviceId: string): SyncEnvelope => ({
  schemaVersion: 1,
  vaultId: CONTRACT_VAULT_ID,
  revision: 1,
  parentRevision: null,
  deviceId,
  keyVersion: 1,
  nonce: 'opaque-nonce',
  ciphertext: 'opaque-ciphertext',
  authTag: 'opaque-auth-tag',
  aad: 'opaque-aad',
  payloadHash: 'a'.repeat(64),
  byteLength: 64
});

const createOpaqueConflictExport = (): SyncConflictExport => ({
  format: 'relay-sync-conflict',
  version: 1,
  conflictId: 'contract-conflict',
  createdAt: CONTRACT_TIMESTAMP,
  copies: [
    {
      copy: 'local',
      revision: 1,
      payloadHash: 'a'.repeat(64),
      kdf: { algorithm: 'argon2id', memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32, salt: 'opaque-salt' },
      wrappedBundleKey: { version: 1, nonce: 'opaque-nonce', ciphertext: 'opaque-key', authTag: 'opaque-tag', aad: 'opaque-aad' },
      payload: { version: 1, nonce: 'opaque-nonce', ciphertext: 'opaque-payload', authTag: 'opaque-tag', aad: 'opaque-aad' }
    },
    {
      copy: 'remote',
      revision: 2,
      payloadHash: 'b'.repeat(64),
      kdf: { algorithm: 'argon2id', memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32, salt: 'opaque-salt' },
      wrappedBundleKey: { version: 1, nonce: 'opaque-nonce', ciphertext: 'opaque-key', authTag: 'opaque-tag', aad: 'opaque-aad' },
      payload: { version: 1, nonce: 'opaque-nonce', ciphertext: 'opaque-payload', authTag: 'opaque-tag', aad: 'opaque-aad' }
    }
  ]
});

export const createInMemoryAccountSyncPorts = (): InMemoryAccountSyncPorts => {
  let account: AccountSession | null = null;
  let descriptor: SyncDescriptor | null = null;
  let envelope: SyncEnvelope | null = null;
  let syncState: SyncState = { sync: 'local-only', head: null, pendingCount: 0 };
  let recoveryState: RecoveryKeyState = { status: 'not-configured', activeKeyVersion: null, pendingKeyVersion: null };
  const revokedDeviceIds = new Set<string>();
  const deviceRows = [
    { id: CONTRACT_DEVICE_ID, label: 'Contract device', platform: 'desktop' as const },
    { id: CONTRACT_SECONDARY_DEVICE_ID, label: 'Secondary device', platform: 'android' as const }
  ];

  const sessionFor = (deviceId: string): AccountSession => ({
    accountId: CONTRACT_ACCOUNT_ID,
    deviceId,
    state: 'signed-in',
    expiresAt: '2026-10-16T00:00:00.000Z'
  });
  const headFor = (value: SyncEnvelope): SyncHead => ({
    vaultId: value.vaultId,
    revision: value.revision,
    keyVersion: value.keyVersion,
    payloadHash: value.payloadHash,
    updatedAt: CONTRACT_TIMESTAMP
  });
  const createDescriptor = (): SyncDescriptor => ({
    vaultId: CONTRACT_VAULT_ID,
    keyVersion: 1,
    vaultUnlockEnvelope: {
      version: 1,
      kdf: {
        algorithm: 'argon2id',
        salt: 'opaque-salt',
        memoryCost: 1,
        timeCost: 1,
        parallelism: 1,
        hashLength: 32
      },
      wrappedVaultKey: {
        version: 1,
        nonce: 'opaque-vault-nonce',
        ciphertext: 'opaque-vault-ciphertext',
        authTag: 'opaque-vault-auth-tag',
        aad: 'opaque-vault-aad'
      }
    },
    wrappedSyncKey: {
      version: 1,
      nonce: 'opaque-sync-nonce',
      ciphertext: 'opaque-sync-ciphertext',
      authTag: 'opaque-sync-auth-tag',
      aad: 'opaque-sync-aad'
    }
  });

  const accountPort: AccountSessionPort = {
    async status() { return account; },
    async register() {
      account = sessionFor(CONTRACT_DEVICE_ID);
      return account;
    },
    async signIn() {
      account = sessionFor(CONTRACT_DEVICE_ID);
      return account;
    },
    async signOut() { account = null; }
  };
  const devicesPort: DeviceTrustPort = {
    async listDevices() {
      return deviceRows.map((device) => ({
        ...device,
        lastSeenAt: CONTRACT_TIMESTAMP,
        current: account?.deviceId === device.id,
        revokedAt: revokedDeviceIds.has(device.id) ? CONTRACT_TIMESTAMP : null
      }));
    },
    async revokeDevice(deviceId) {
      if (!deviceRows.some((device) => device.id === deviceId) || account?.deviceId === deviceId) throw new Error('cannot revoke current device');
      revokedDeviceIds.add(deviceId);
    }
  };
  const syncPort: SyncPort = {
    async status() { return { ...syncState, recovery: recoveryState }; },
    async descriptor() { return descriptor; },
    async pull() { return envelope ? { ...envelope } : null; },
    async push(nextEnvelope) {
      envelope = { ...nextEnvelope };
      const head = headFor(envelope);
      syncState = { sync: 'synced', head, pendingCount: 0, lastSyncedAt: CONTRACT_TIMESTAMP };
      return head;
    },
    async previewPull() {
      return {
        conflictId: 'contract-conflict',
        localRevision: 0,
        remoteRevision: syncState.head?.revision ?? 1,
        conflictTypes: ['host', 'workspace'],
        localBackupRevision: 0
      } satisfies SyncPreview;
    },
    async exportConflict() {
      return createOpaqueConflictExport();
    },
    async resolveConflict() {
      syncState = { ...syncState, sync: 'synced', pendingCount: 0 };
    },
    async enable() {
      if (!descriptor) descriptor = createDescriptor();
      if (!envelope) envelope = createOpaqueEnvelope(account?.deviceId ?? CONTRACT_DEVICE_ID);
      const head = headFor(envelope);
      syncState = { sync: 'synced', head, pendingCount: 0, lastSyncedAt: CONTRACT_TIMESTAMP };
      return head;
    },
    async issueRecoveryKey(reveal: RecoveryKeyReveal): Promise<RecoveryKeyState> {
      recoveryState = { status: 'pending-confirmation', activeKeyVersion: recoveryState.activeKeyVersion, pendingKeyVersion: (recoveryState.activeKeyVersion ?? 0) + 1 };
      reveal('RLY-RK1-CONTRACT-RECOVERY-KEY', recoveryState.pendingKeyVersion!);
      return recoveryState;
    },
    async confirmRecoveryKey(): Promise<RecoveryKeyState> {
      recoveryState = { status: 'configured', activeKeyVersion: recoveryState.pendingKeyVersion ?? 1, pendingKeyVersion: null };
      return recoveryState;
    },
    async retry() {
      syncState = { ...syncState, sync: 'synced', pendingCount: 0 };
    }
  };
  return { account: accountPort, devices: devicesPort, sync: syncPort };
};

const NATIVE_CAPABILITIES: readonly Capability[] = [
  'workspace.persistence',
  'workspace.templates',
  'workspace.multi-pane',
  'workspace.max-panes',
  'terminal.broadcast',
  'vault.bundle',
  'vault.identities',
  'ssh.shell',
  'ssh.reconnect',
  'ssh.proxy-jump',
  'session.reattach',
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
  supportedCapabilities: readonly Capability[] = NATIVE_CAPABILITIES,
  options: InMemoryCoreRuntimeOptions = {}
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
      async delete() {},
      async clearHostKey() {}
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
      async list() { return { items: [] }; }
    },
    imports: {
      async previewExternalImport() { throw new Error('unused'); },
      async applyExternalImport() { throw new Error('unused'); },
      async exportOpenSshConfig() { return new Uint8Array([0x48, 0x6f, 0x73, 0x74]); },
      async exportCsv() { return new Uint8Array([0x6e, 0x61, 0x6d, 0x65]); },
      async exportVaultBundle() { return 'native-vault-bundle'; },
      async previewVaultImport() { throw new Error('unused'); },
      async applyVaultImport() { throw new Error('unused'); }
    },
    ...(options.account === undefined ? {} : { account: options.account }),
    ...(options.devices === undefined ? {} : { devices: options.devices }),
    ...(options.sync === undefined ? {} : { sync: options.sync })
  };
  return runtime;
};

export const createNativeLikeRuntime = (
  platform: Extract<ClientPlatform, 'desktop' | 'android'>,
  options: InMemoryCoreRuntimeOptions = {}
): CoreRuntime => {
  const optionalCapabilities: Capability[] = [
    ...(options.account ? ['account.auth' as const] : []),
    ...(options.devices ? ['device.trust' as const] : []),
    ...(options.sync ? ['sync.encrypted' as const] : [])
  ];
  return createInMemoryCoreRuntime(platform, [...NATIVE_CAPABILITIES, ...optionalCapabilities], options);
};
