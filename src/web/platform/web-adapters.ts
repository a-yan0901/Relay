import type { CapabilitySet } from '../../shared/core/capabilities';
import { createWebCapabilitySet, negotiateCapabilitySet, WEB_CLIENT_CAPABILITIES } from '../../shared/core/capabilities';
import type { AccountDeletionConfirmation, CloudSyncDeletionConfirmation } from '../../shared/core/account-sync';
import type {
  AccountSession,
  AccountDeletionState,
  ActivityFilter,
  ActivityPage,
  Capability,
  CommandRun,
  CommandRunRequest,
  ConnectionTestResult,
  ConnectionProfile,
  DeviceDescriptor,
  GroupNode,
  HostListFilter,
  IdentityMetadata,
  RecoveryKeyState,
  SftpEntry,
  Snippet,
  SnippetMetadata,
  SyncConflictExport,
  SyncDeletionState,
  SyncDescriptor,
  SyncEnvelope,
  SyncHead,
  SyncPreview,
  SyncResolution,
  SyncStatus,
  VaultRecoveryPreview,
  TransferJob,
  TransferResumeRequest,
  TransferRequest,
  WorkspaceState
} from '../../shared/core/models';
import type { GroupPatchInput, HostCreateInput, HostMetadata, HostPatchInput, IdentityCreateInput, IdentityUpdateInput, GroupMutationInput, SnippetInput, SnippetPatchInput } from '../../shared/validation';
import type { ExportOptions, ImportApplyRequest, ImportFormat, ImportPreview, ImportSourceFile, VaultBundleApplyResult, VaultBundlePreview, VaultBundleResolution } from '../../shared/import/types';
import { defaultConnectionProfileSettings } from '../../shared/validation';
import type {
  AccountSessionPort,
  BinarySource,
  ByteStream,
  CommandTransport,
  ConnectionProbe,
  DeviceTrustPort,
  FileTransport,
  GroupStore,
  HostStore,
  IdentityStore,
  ImportExportPort,
  PlatformServices,
  RecoveryKeyReveal,
  SecretRef,
  SecretStore,
  SessionEvent,
  SessionHandle,
  SessionTransport,
  SnippetStore,
  SyncPort,
  VaultRecoveryInput,
  VaultRecoveryPort,
  VaultSessionPort,
  WorkspaceStore,
  OpenShellRequest
} from '../../shared/core/ports';
import type { CoreRuntime } from '../../shared/core/runtime';
import { AppError } from '../../shared/errors';
import type { TerminalSocketLike } from '../hooks/use-terminal-session';
import { TerminalSessionController } from '../hooks/use-terminal-session';
import { createBrowserSystemServices } from './browser-system-services';
import * as api from '../api';
import type { CapabilityResponse } from '../api';
import { Sha256 } from '../../shared/crypto/sha256';

/** Browser UI upper bound; server capabilities are intersected with this value below. */
export const WEB_PLATFORM_MAX_PANES = 4;

const webPaneLimit = (serverLimit: number | undefined): number => {
  if (serverLimit === undefined || !Number.isFinite(serverLimit)) return WEB_PLATFORM_MAX_PANES;
  return Math.max(1, Math.min(WEB_PLATFORM_MAX_PANES, Math.floor(serverLimit)));
};

const createEffectiveWebCapabilitySet = (clientCapabilities: readonly Capability[], serverCapabilities: readonly Capability[], serverLimit?: number): CapabilitySet => {
  return negotiateCapabilitySet('web', clientCapabilities, serverCapabilities, { maxWorkspacePanes: webPaneLimit(serverLimit) });
};

const emptyWorkspace = (): WorkspaceState => ({
  version: 0,
  tabs: [],
  activeTabId: null,
  layout: { mode: 'single', ratio: 0.5 },
  filters: { query: '', groupId: null, favoriteOnly: false }
});

export interface WorkspaceWebAdapter extends WorkspaceStore {}

export interface WebApiClient {
  getSetupStatus?: typeof api.getSetupStatus;
  setupVault?: typeof api.setupVault;
  unlockVault?: typeof api.unlockVault;
  lockVault?: typeof api.lockVault;
  getWorkspace?: typeof api.getWorkspace;
  saveWorkspace?: typeof api.saveWorkspace;
  listWorkspaceTemplates?: typeof api.listWorkspaceTemplates;
  createWorkspaceTemplate?: typeof api.createWorkspaceTemplate;
  deleteWorkspaceTemplate?: typeof api.deleteWorkspaceTemplate;
  exportVaultBundle?: typeof api.exportVaultBundle;
  previewVaultImport?: typeof api.previewVaultImport;
  applyVaultImport?: typeof api.applyVaultImport;
  previewExternalImport?: typeof api.previewExternalImport;
  applyExternalImport?: typeof api.applyExternalImport;
  exportOpenSshConfig?: typeof api.exportOpenSshConfig;
  exportSshCsv?: typeof api.exportSshCsv;
  listHosts?: typeof api.listHosts;
  getHost?: typeof api.getHost;
  createHost?: typeof api.createHost;
  updateHost?: typeof api.updateHost;
  deleteHost?: typeof api.deleteHost;
  clearHostKey?: typeof api.clearHostKey;
  listGroups?: typeof api.listGroups;
  getGroup?: typeof api.getGroup;
  createGroup?: typeof api.createGroup;
  updateGroup?: typeof api.updateGroup;
  deleteGroup?: typeof api.deleteGroup;
  testConnection?: typeof api.testConnection;
  listIdentities?: typeof api.listIdentities;
  getIdentity?: typeof api.getIdentity;
  createIdentity?: typeof api.createIdentity;
  updateIdentity?: typeof api.updateIdentity;
  deleteIdentity?: typeof api.deleteIdentity;
  listSftpEntries?: typeof api.listSftpEntries;
  mutateSftpEntry?: typeof api.mutateSftpEntry;
  createTransfer?: typeof api.createTransfer;
  listTransfers?: typeof api.listTransfers;
  getTransfer?: typeof api.getTransfer;
  uploadTransferContent?: typeof api.uploadTransferContent;
  uploadTransferChunk?: typeof api.uploadTransferChunk;
  downloadTransferContent?: typeof api.downloadTransferContent;
  cancelTransfer?: typeof api.cancelTransfer;
  pauseTransfer?: typeof api.pauseTransfer;
  retryTransfer?: typeof api.retryTransfer;
  listSnippets?: typeof api.listSnippets;
  getSnippet?: typeof api.getSnippet;
  createSnippet?: typeof api.createSnippet;
  updateSnippet?: typeof api.updateSnippet;
  deleteSnippet?: typeof api.deleteSnippet;
  startCommandRun?: typeof api.startCommandRun;
  getCommandRun?: typeof api.getCommandRun;
  cancelCommandRun?: typeof api.cancelCommandRun;
  listAuditEvents?: typeof api.listAuditEvents;
  getCapabilities?: typeof api.getCapabilities;
  getAccountSession?: typeof api.getAccountSession;
  register?: typeof api.register;
  signIn?: typeof api.signIn;
  signOut?: typeof api.signOut;
  reauthenticate?: typeof api.reauthenticate;
  getAccountDeletion?: typeof api.getAccountDeletion;
  requestAccountDeletion?: typeof api.requestAccountDeletion;
  restoreAccountDeletion?: typeof api.restoreAccountDeletion;
  listDevices?: typeof api.listDevices;
  revokeDevice?: typeof api.revokeDevice;
  getSyncState?: typeof api.getSyncState;
  getSyncDescriptor?: typeof api.getSyncDescriptor;
  enableSync?: typeof api.enableSync;
  retrySync?: typeof api.retrySync;
  getSyncEnvelope?: typeof api.getSyncEnvelope;
  pushSyncEnvelope?: typeof api.pushSyncEnvelope;
  previewPull?: typeof api.previewPull;
  resolveConflict?: typeof api.resolveConflict;
  exportConflict?: typeof api.exportConflict;
  requestCloudDeletion?: typeof api.requestCloudDeletion;
  restoreCloudDeletion?: typeof api.restoreCloudDeletion;
  issueRecoveryKey?: typeof api.issueRecoveryKey;
  confirmRecoveryKey?: typeof api.confirmRecoveryKey;
  previewSyncRecovery?: typeof api.previewSyncRecovery;
  applySyncRecovery?: typeof api.applySyncRecovery;
}

const requireApi = <T>(value: T | undefined): T => {
  if (!value) throw new AppError('CAPABILITY_UNAVAILABLE');
  return value;
};

const hasFunction = (client: WebApiClient, name: keyof WebApiClient): boolean => {
  try {
    return typeof client[name] === 'function';
  } catch {
    // Partial module mocks may throw when an optional export is absent.
    return false;
  }
};

const hasAccountApi = (client: WebApiClient): boolean => (
  hasFunction(client, 'getAccountSession')
  && hasFunction(client, 'register')
  && hasFunction(client, 'signIn')
  && hasFunction(client, 'signOut')
);

const hasDeviceApi = (client: WebApiClient): boolean => hasFunction(client, 'listDevices') && hasFunction(client, 'revokeDevice');

const hasSyncApi = (client: WebApiClient): boolean => (
  hasFunction(client, 'getSyncState')
  && hasFunction(client, 'getSyncDescriptor')
  && hasFunction(client, 'enableSync')
  && hasFunction(client, 'retrySync')
  && hasFunction(client, 'previewPull')
  && hasFunction(client, 'resolveConflict')
);

const hasVaultRecoveryApi = (client: WebApiClient): boolean => (
  hasFunction(client, 'previewSyncRecovery') && hasFunction(client, 'applySyncRecovery')
);

export const createWorkspaceWebAdapter = (client: WebApiClient = api): WorkspaceWebAdapter => ({
  load: () => client.getWorkspace?.() ?? Promise.resolve(emptyWorkspace()),
  save: (expectedVersion, state) => client.saveWorkspace?.(expectedVersion, state) ?? Promise.resolve(state),
  listTemplates: () => client.listWorkspaceTemplates?.() ?? Promise.resolve([]),
  createTemplate: (input) => requireApi(client.createWorkspaceTemplate)(input),
  deleteTemplate: (templateId) => requireApi(client.deleteWorkspaceTemplate)(templateId)
});

export const webWorkspaceAdapter = createWorkspaceWebAdapter();

const profileFromHost = (host: HostMetadata): ConnectionProfile => ({
  hostId: host.id,
  address: host.address,
  port: host.port,
  username: host.username,
  authType: host.authType,
  jumpHostIds: host.jumpHostIds ?? [],
  keepaliveIntervalMs: host.resolvedConnectionProfile?.keepaliveIntervalMs ?? host.connectionProfile?.keepaliveIntervalMs ?? defaultConnectionProfileSettings().keepaliveIntervalMs,
  keepaliveCountMax: host.resolvedConnectionProfile?.keepaliveCountMax ?? host.connectionProfile?.keepaliveCountMax ?? defaultConnectionProfileSettings().keepaliveCountMax,
  reconnect: host.resolvedConnectionProfile?.reconnect ?? host.connectionProfile?.reconnect ?? defaultConnectionProfileSettings().reconnect,
  hostKeyAlgorithm: host.hostKeyAlgorithm,
  hostKeyFingerprint: host.hostKeyFingerprint
});

export class WebHostStore implements HostStore {
  constructor(private readonly client: Pick<WebApiClient, 'listHosts' | 'getHost'> & Partial<Pick<WebApiClient, 'createHost' | 'updateHost' | 'deleteHost' | 'clearHostKey'>> = api) {}

  list(filter: HostListFilter = {}): Promise<readonly HostMetadata[]> {
    return requireApi(this.client.listHosts)(filter);
  }

  async get(hostId: string): Promise<HostMetadata | null> {
    try {
      return await requireApi(this.client.getHost)(hostId);
    } catch (error) {
      if (error instanceof AppError && error.code === 'HOST_NOT_FOUND') return null;
      throw error;
    }
  }

  async listProfiles(): Promise<readonly ConnectionProfile[]> {
    const hosts = await this.list();
    return hosts.map(profileFromHost);
  }

  async getProfile(hostId: string): Promise<ConnectionProfile | null> {
    const host = await this.get(hostId);
    return host ? profileFromHost(host) : null;
  }

  create(input: HostCreateInput): Promise<HostMetadata> {
    return requireApi(this.client.createHost)(input);
  }

  update(hostId: string, input: HostPatchInput): Promise<HostMetadata> {
    return requireApi(this.client.updateHost)(hostId, input);
  }

  delete(hostId: string): Promise<void> {
    return requireApi(this.client.deleteHost)(hostId);
  }

  clearHostKey(hostId: string): Promise<void> {
    return requireApi(this.client.clearHostKey)(hostId);
  }
}

export class WebSecretStore implements SecretStore {
  async get(_ref: SecretRef | string): Promise<null> {
    return null;
  }

  async set(_ref: SecretRef | string, _secret: unknown): Promise<void> {
    throw new AppError('CAPABILITY_UNAVAILABLE', 'Web 客户端不在浏览器中保存主机秘密');
  }

  async remove(_ref: SecretRef | string): Promise<void> {
    throw new AppError('CAPABILITY_UNAVAILABLE', 'Web 客户端不在浏览器中保存主机秘密');
  }
}

type WebFileClient = Pick<WebApiClient, 'listSftpEntries' | 'createTransfer' | 'cancelTransfer'> & Partial<Pick<WebApiClient, 'listTransfers' | 'getTransfer' | 'mutateSftpEntry' | 'uploadTransferContent' | 'uploadTransferChunk' | 'downloadTransferContent' | 'pauseTransfer' | 'retryTransfer'>>;

const readableStreamToByteStream = (stream: ReadableStream<Uint8Array>): ByteStream => (async function* () {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
})();

const WEB_UPLOAD_CHUNK_BYTES = 1024 * 1024;

interface WebUploadChunk {
  data: Uint8Array;
  resume: TransferResumeRequest;
  nextChecksum: string;
  final: boolean;
}

const uploadChunks = async function* (transferId: string, source: ByteStream, sourceSize: number | null, resume?: TransferResumeRequest): AsyncGenerator<WebUploadChunk> {
  const iterator = source[Symbol.asyncIterator]();
  const hash = new Sha256();
  const initialOffset = resume?.expectedOffset ?? 0;
  const expectedPrefixChecksum = resume?.checksum?.toLowerCase() ?? null;
  let sourceOffset = 0;
  let serverOffset = initialOffset;
  let pending: Uint8Array | undefined;
  let ended = false;
  let prefixChecked = initialOffset === 0;
  let emitted = false;

  const readNext = async (): Promise<Uint8Array | undefined> => {
    for (;;) {
      const next = await iterator.next();
      if (next.done) {
        ended = true;
        return undefined;
      }
      const value = next.value;
      if (value.byteLength > 0) return value;
    }
  };

  const checkPrefix = (): void => {
    if (prefixChecked || sourceOffset < initialOffset) return;
    const actual = hash.digestHex();
    if (expectedPrefixChecksum === null || actual !== expectedPrefixChecksum) throw new AppError('TRANSFER_RESUME_INVALID');
    prefixChecked = true;
  };

  try {
    for (;;) {
      const parts: Uint8Array[] = [];
      let partBytes = 0;
      let checksumBefore: string | null = null;

      while (partBytes < WEB_UPLOAD_CHUNK_BYTES) {
        if (pending === undefined && !ended) pending = await readNext();
        if (pending === undefined) break;

        const skip = Math.min(pending.byteLength, Math.max(0, initialOffset - sourceOffset));
        if (skip > 0) {
          const prefix = pending.subarray(0, skip);
          hash.update(prefix);
          sourceOffset += skip;
          pending = skip === pending.byteLength ? undefined : pending.subarray(skip);
          checkPrefix();
          continue;
        }

        checkPrefix();
        if (checksumBefore === null) checksumBefore = hash.digestHex();
        const take = Math.min(WEB_UPLOAD_CHUNK_BYTES - partBytes, pending.byteLength);
        const value = pending.subarray(0, take);
        parts.push(value);
        hash.update(value);
        sourceOffset += take;
        partBytes += take;
        pending = take === pending.byteLength ? undefined : pending.subarray(take);
      }

      if (partBytes === 0) {
        if (sourceOffset < initialOffset) throw new AppError('TRANSFER_RESUME_INVALID');
        if (!emitted && sourceOffset === initialOffset) {
          checkPrefix();
          yield {
            data: new Uint8Array(),
            resume: { transferId, expectedOffset: serverOffset, checksum: serverOffset === 0 ? null : expectedPrefixChecksum },
            nextChecksum: hash.digestHex(),
            final: true
          };
        }
        break;
      }

      if (pending === undefined && !ended) pending = await readNext();
      const final = pending === undefined && ended;
      const data = new Uint8Array(partBytes);
      let dataOffset = 0;
      for (const part of parts) {
        data.set(part, dataOffset);
        dataOffset += part.byteLength;
      }
      yield {
        data,
        resume: { transferId, expectedOffset: serverOffset, checksum: serverOffset === 0 ? null : checksumBefore ?? expectedPrefixChecksum },
        nextChecksum: hash.digestHex(),
        final
      };
      emitted = true;
      serverOffset += partBytes;
      if (sourceSize !== null && sourceOffset > sourceSize) throw new AppError('TRANSFER_RESUME_INVALID');
    }
  } finally {
    await iterator.return?.();
  }
};

export class WebFileTransport implements FileTransport {
  constructor(private readonly client: WebFileClient = api) {}

  list(hostId: string, path: string): Promise<readonly SftpEntry[]> {
    return requireApi(this.client.listSftpEntries)(hostId, path);
  }

  createDirectory(hostId: string, path: string): Promise<void> {
    return requireApi(this.client.mutateSftpEntry)(hostId, { action: 'mkdir', path });
  }

  rename(hostId: string, from: string, to: string): Promise<void> {
    return requireApi(this.client.mutateSftpEntry)(hostId, { action: 'rename', from, to });
  }

  remove(hostId: string, path: string): Promise<void> {
    return requireApi(this.client.mutateSftpEntry)(hostId, { action: 'delete', path, confirmed: true });
  }

  createTransfer(request: TransferRequest): Promise<TransferJob> {
    return requireApi(this.client.createTransfer)(request);
  }

  async listTransfers(): Promise<readonly TransferJob[]> {
    return this.client.listTransfers?.() ?? [];
  }

  getTransfer(transferId: string): Promise<TransferJob | null> {
    return requireApi(this.client.getTransfer)(transferId).catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'TRANSFER_NOT_FOUND') return null;
      throw error;
    });
  }

  async upload(transferId: string, source: BinarySource, resume?: TransferResumeRequest): Promise<TransferJob> {
    const uploadChunk = requireApi(this.client.uploadTransferChunk);
    let latest: TransferJob | undefined;
    for await (const chunk of uploadChunks(transferId, source.stream(), source.size, resume)) {
      const blob = new Blob([chunk.data.slice().buffer as ArrayBuffer], { type: 'application/octet-stream' });
      latest = await uploadChunk(transferId, blob, chunk.resume, chunk.nextChecksum, chunk.final);
      if (latest.status === 'completed') return latest;
    }
    if (!latest) throw new AppError('TRANSFER_RESUME_INVALID');
    return latest;
  }

  async download(transferId: string, resume?: TransferResumeRequest): Promise<ByteStream> {
    return readableStreamToByteStream(await requireApi(this.client.downloadTransferContent)(transferId, resume));
  }

  cancelTransfer(transferId: string): Promise<void> {
    return requireApi(this.client.cancelTransfer)(transferId);
  }

  pauseTransfer(transferId: string): Promise<void> {
    return requireApi(this.client.pauseTransfer)(transferId);
  }

  retryTransfer(transferId: string): Promise<TransferJob> {
    return requireApi(this.client.retryTransfer)(transferId);
  }
}

type WebAccountClient = Pick<WebApiClient, 'getAccountSession' | 'register' | 'signIn' | 'signOut'> & Partial<Pick<WebApiClient, 'reauthenticate' | 'getAccountDeletion' | 'requestAccountDeletion' | 'restoreAccountDeletion'>>;

export class WebAccountSession implements AccountSessionPort {
  constructor(private readonly client: WebAccountClient = api) {}

  async status(): Promise<AccountSession | null> {
    return (await requireApi(this.client.getAccountSession)()).account;
  }

  async register(email: string, password: string, label?: string): Promise<AccountSession> {
    return (await requireApi(this.client.register)(email, password, label)).account;
  }

  async signIn(email: string, password: string, label?: string): Promise<AccountSession> {
    return (await requireApi(this.client.signIn)(email, password, label)).account;
  }

  signOut(): Promise<void> {
    return requireApi(this.client.signOut)();
  }

  reauthenticate(password: string): Promise<void> {
    return requireApi(this.client.reauthenticate)(password);
  }

  async getDeletion(): Promise<AccountDeletionState | null> {
    return (await requireApi(this.client.getAccountDeletion)()).deletion;
  }

  async requestDeletion(confirmDelete: AccountDeletionConfirmation): Promise<AccountDeletionState> {
    const response = await requireApi(this.client.requestAccountDeletion)(confirmDelete);
    if (!response.deletion) throw new AppError('PROTOCOL_INVALID_MESSAGE');
    return response.deletion;
  }

  restoreDeletion(): Promise<void> {
    return requireApi(this.client.restoreAccountDeletion)();
  }
}

type WebDeviceClient = Pick<WebApiClient, 'listDevices' | 'revokeDevice'>;

export class WebDeviceTrust implements DeviceTrustPort {
  constructor(private readonly client: WebDeviceClient = api) {}

  listDevices(): Promise<readonly DeviceDescriptor[]> {
    return requireApi(this.client.listDevices)();
  }

  revokeDevice(deviceId: string): Promise<void> {
    return requireApi(this.client.revokeDevice)(deviceId);
  }
}

type WebSyncClient = Pick<WebApiClient, 'getSyncState' | 'getSyncDescriptor' | 'enableSync' | 'retrySync' | 'previewPull' | 'resolveConflict'> & Partial<Pick<WebApiClient, 'getSyncEnvelope' | 'pushSyncEnvelope' | 'issueRecoveryKey' | 'confirmRecoveryKey' | 'exportConflict' | 'requestCloudDeletion' | 'restoreCloudDeletion'>>;

export class WebSync implements SyncPort {
  constructor(private readonly client: WebSyncClient = api) {}

  async status(): Promise<{ sync: SyncStatus; head: SyncHead | null; pendingCount?: number; lastErrorCode?: string; recovery?: RecoveryKeyState; deletion?: SyncDeletionState }> {
    const response = await requireApi(this.client.getSyncState)();
    return {
      sync: response.sync,
      head: response.head,
      ...(response.pendingCount === undefined ? {} : { pendingCount: response.pendingCount }),
      ...(response.lastErrorCode === undefined && response.lastError === undefined ? {} : { lastErrorCode: response.lastErrorCode ?? response.lastError }),
      ...(response.recovery === undefined ? {} : { recovery: response.recovery }),
      ...(response.deletion === undefined ? {} : { deletion: response.deletion })
    };
  }

  descriptor(): Promise<SyncDescriptor | null> {
    return requireApi(this.client.getSyncDescriptor)();
  }

  pull(): Promise<SyncEnvelope | null> {
    return requireApi(this.client.getSyncEnvelope)();
  }

  push(envelope: SyncEnvelope, idempotencyKey: string): Promise<SyncHead> {
    return requireApi(this.client.pushSyncEnvelope)(envelope, idempotencyKey);
  }

  previewPull(): Promise<SyncPreview> {
    return requireApi(this.client.previewPull)();
  }

  async exportConflict(conflictId: string, exportPassword: string): Promise<SyncConflictExport> {
    return requireApi(this.client.exportConflict)(conflictId, exportPassword);
  }

  resolveConflict(conflictId: string, resolution: SyncResolution): Promise<void> {
    return requireApi(this.client.resolveConflict)(conflictId, resolution);
  }

  enable(): Promise<SyncHead> {
    return requireApi(this.client.enableSync)();
  }

  async issueRecoveryKey(reveal: RecoveryKeyReveal): Promise<RecoveryKeyState> {
    const issue = await requireApi(this.client.issueRecoveryKey)();
    reveal(issue.recoveryKey, issue.keyVersion);
    return issue.recovery;
  }

  async confirmRecoveryKey(recoveryKey: string): Promise<RecoveryKeyState> {
    return requireApi(this.client.confirmRecoveryKey)(recoveryKey);
  }

  retry(): Promise<void> {
    return requireApi(this.client.retrySync)();
  }

  requestCloudDeletion(confirmDelete: CloudSyncDeletionConfirmation): Promise<SyncDeletionState> {
    return requireApi(this.client.requestCloudDeletion)(confirmDelete);
  }

  restoreCloudDeletion(): Promise<void> {
    return requireApi(this.client.restoreCloudDeletion)();
  }
}

export class WebVaultSession implements VaultSessionPort {
  constructor(private readonly client: Pick<WebApiClient, 'getSetupStatus'> & Partial<Pick<WebApiClient, 'setupVault' | 'unlockVault' | 'lockVault'>> = api) {}

  private async readStatus(): Promise<{ initialized: boolean; locked: boolean }> {
    return this.client.getSetupStatus?.() ?? { initialized: false, locked: true };
  }

  async status(): Promise<{ phase: 'uninitialized' | 'locked' | 'unlocked' }> {
    const status = await this.readStatus();
    return { phase: !status.initialized ? 'uninitialized' : status.locked ? 'locked' : 'unlocked' };
  }

  async setup(masterPassword: string): Promise<{ phase: 'uninitialized' | 'locked' | 'unlocked' }> {
    await requireApi(this.client.setupVault)(masterPassword);
    return { phase: 'unlocked' };
  }

  async unlock(masterPassword: string): Promise<{ phase: 'uninitialized' | 'locked' | 'unlocked' }> {
    await requireApi(this.client.unlockVault)(masterPassword);
    return { phase: 'unlocked' };
  }

  async lock(): Promise<void> {
    await requireApi(this.client.lockVault)();
  }
}

type WebVaultRecoveryClient = Partial<Pick<WebApiClient, 'previewSyncRecovery' | 'applySyncRecovery'>>;

export class WebVaultRecovery implements VaultRecoveryPort {
  constructor(private readonly client: WebVaultRecoveryClient = api) {}

  async preview(input: VaultRecoveryInput): Promise<VaultRecoveryPreview> {
    return requireApi(this.client.previewSyncRecovery)(input);
  }

  async apply(previewId: string, input: VaultRecoveryInput): Promise<{ phase: 'unlocked' }> {
    await requireApi(this.client.applySyncRecovery)(previewId, input);
    return { phase: 'unlocked' };
  }
}

export class WebConnectionProbe implements ConnectionProbe {
  constructor(private readonly client: Pick<WebApiClient, 'testConnection'> = api) {}

  test(hostId: string): Promise<ConnectionTestResult> {
    return requireApi(this.client.testConnection)(hostId);
  }
}

const groupFromResponse = (group: GroupNode): GroupNode => ({
  id: group.id,
  name: group.name,
  parentId: group.parentId ?? null,
  sortOrder: group.sortOrder ?? 0,
  defaultIdentityId: group.defaultIdentityId ?? null,
  connectionProfile: group.connectionProfile ?? null
});

export class WebGroupStore implements GroupStore {
  constructor(private readonly client: Pick<WebApiClient, 'listGroups'> & Partial<Pick<WebApiClient, 'getGroup' | 'createGroup' | 'updateGroup' | 'deleteGroup'>> = api) {}

  async list(): Promise<readonly GroupNode[]> {
    return (await requireApi(this.client.listGroups)()).map(groupFromResponse);
  }

  async get(groupId: string): Promise<GroupNode | null> {
    try {
      return groupFromResponse(await requireApi(this.client.getGroup)(groupId));
    } catch (error) {
      if (error instanceof AppError && error.code === 'GROUP_NOT_FOUND') return null;
      throw error;
    }
  }

  create(input: GroupMutationInput): Promise<GroupNode> {
    return requireApi(this.client.createGroup)(input).then(groupFromResponse);
  }

  update(groupId: string, input: GroupPatchInput): Promise<GroupNode> {
    return requireApi(this.client.updateGroup)(groupId, input).then(groupFromResponse);
  }

  delete(groupId: string): Promise<void> {
    return requireApi(this.client.deleteGroup)(groupId);
  }
}

export class WebIdentityStore implements IdentityStore {
  constructor(private readonly client: Pick<WebApiClient, 'listIdentities'> & Partial<Pick<WebApiClient, 'getIdentity' | 'createIdentity' | 'updateIdentity' | 'deleteIdentity'>> = {}) {}

  async list(): Promise<readonly IdentityMetadata[]> {
    return await requireApi(this.client.listIdentities)();
  }

  async get(identityId: string): Promise<IdentityMetadata | null> {
    try {
      return await requireApi(this.client.getIdentity)(identityId);
    } catch (error) {
      if (error instanceof AppError && error.code === 'IDENTITY_NOT_FOUND') return null;
      throw error;
    }
  }

  create(input: IdentityCreateInput): Promise<IdentityMetadata> {
    return requireApi(this.client.createIdentity)(input);
  }

  update(identityId: string, input: IdentityUpdateInput): Promise<IdentityMetadata> {
    return requireApi(this.client.updateIdentity)(identityId, input);
  }

  delete(identityId: string): Promise<void> {
    return requireApi(this.client.deleteIdentity)(identityId);
  }
}

export class WebSnippetStore implements SnippetStore {
  constructor(private readonly client: Pick<WebApiClient, 'listSnippets'> & Partial<Pick<WebApiClient, 'getSnippet' | 'createSnippet' | 'updateSnippet' | 'deleteSnippet'>> = api) {}

  list(): Promise<readonly SnippetMetadata[]> {
    return requireApi(this.client.listSnippets)();
  }

  async get(snippetId: string): Promise<Snippet | null> {
    try {
      return await requireApi(this.client.getSnippet)(snippetId);
    } catch (error) {
      if (error instanceof AppError && error.code === 'SNIPPET_NOT_FOUND') return null;
      throw error;
    }
  }

  create(input: SnippetInput): Promise<Snippet> {
    return requireApi(this.client.createSnippet)({ ...input, description: input.description ?? null });
  }

  update(snippetId: string, input: SnippetPatchInput): Promise<Snippet> {
    return requireApi(this.client.updateSnippet)(snippetId, input);
  }

  delete(snippetId: string): Promise<void> {
    return requireApi(this.client.deleteSnippet)(snippetId);
  }
}

export class WebActivityStore {
  constructor(private readonly client: Pick<WebApiClient, 'listAuditEvents'> = api) {}

  async list(filter: ActivityFilter = {}): Promise<ActivityPage> {
    return requireApi(this.client.listAuditEvents)(filter);
  }
}

const toWebFile = (source: ImportSourceFile): File => new File([
  typeof source.content === 'string' ? source.content : source.content.slice().buffer as ArrayBuffer
], source.filename);

const blobToBytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

export class WebImportExportAdapter implements ImportExportPort {
  constructor(private readonly client: Pick<WebApiClient, 'previewExternalImport' | 'applyExternalImport' | 'exportOpenSshConfig' | 'exportSshCsv' | 'exportVaultBundle' | 'previewVaultImport' | 'applyVaultImport'> = api) {
    // Import/export methods are passed directly to React components as callbacks.
    // Bind them so the adapter remains safe when invoked without its receiver.
    this.previewExternalImport = this.previewExternalImport.bind(this);
    this.applyExternalImport = this.applyExternalImport.bind(this);
    this.exportOpenSshConfig = this.exportOpenSshConfig.bind(this);
    this.exportCsv = this.exportCsv.bind(this);
    this.exportVaultBundle = this.exportVaultBundle.bind(this);
    this.previewVaultImport = this.previewVaultImport.bind(this);
    this.applyVaultImport = this.applyVaultImport.bind(this);
  }

  previewExternalImport(files: readonly ImportSourceFile[], formatHint?: ImportFormat): Promise<ImportPreview> {
    return requireApi(this.client.previewExternalImport)(files.map(toWebFile), formatHint);
  }

  applyExternalImport(previewId: string, input: ImportApplyRequest) {
    return requireApi(this.client.applyExternalImport)(previewId, input);
  }

  async exportOpenSshConfig(): Promise<Uint8Array> {
    return blobToBytes(await requireApi(this.client.exportOpenSshConfig)());
  }

  async exportCsv(options?: ExportOptions): Promise<Uint8Array> {
    return blobToBytes(await requireApi(this.client.exportSshCsv)(options));
  }

  async exportVaultBundle(exportPassword: string): Promise<string> {
    return (await requireApi(this.client.exportVaultBundle)(exportPassword)).bundle;
  }

  previewVaultImport(exportPassword: string, bundle: string): Promise<VaultBundlePreview> {
    return requireApi(this.client.previewVaultImport)(exportPassword, bundle);
  }

  applyVaultImport(previewId: string, resolution: VaultBundleResolution): Promise<VaultBundleApplyResult> {
    return requireApi(this.client.applyVaultImport)(previewId, resolution);
  }
}

export class WebCommandTransport implements CommandTransport {
  constructor(private readonly client: Pick<WebApiClient, 'startCommandRun' | 'getCommandRun' | 'cancelCommandRun'> = api) {}

  start(request: CommandRunRequest): Promise<CommandRun> {
    return requireApi(this.client.startCommandRun)(request);
  }

  get(runId: string): Promise<CommandRun | null> {
    return requireApi(this.client.getCommandRun)(runId);
  }

  cancel(runId: string): Promise<void> {
    return requireApi(this.client.cancelCommandRun)(runId);
  }
}

export class WebCapabilityAdapter {
  constructor(
    private readonly client: Pick<WebApiClient, 'getCapabilities'> = api,
    private readonly clientCapabilities: readonly Capability[] = WEB_CLIENT_CAPABILITIES
  ) {}

  async load(): Promise<CapabilitySet> {
    const response = await this.client.getCapabilities?.() ?? { client: 'web', version: 1, capabilities: [...createWebCapabilitySet().capabilities] } satisfies CapabilityResponse;
    if (response.version !== 1 || response.client !== 'web' || !Array.isArray(response.capabilities)) throw new AppError('CAPABILITY_UNAVAILABLE');
    const serverLimit = response.limits?.maxWorkspacePanes ?? response.limits?.maxPanes;
    return createEffectiveWebCapabilitySet(this.clientCapabilities, response.capabilities, serverLimit);
  }
}

interface ManagedSession {
  controller: TerminalSessionController;
  handle: SessionHandle;
}

export interface WebSessionTransportOptions {
  webSocketFactory?: (url: string) => TerminalSocketLike;
}

export class WebSessionTransport implements SessionTransport {
  private readonly sessions = new Map<string, ManagedSession>();

  constructor(private readonly options: WebSessionTransportOptions = {}) {}

  async openShell(request: OpenShellRequest): Promise<SessionHandle> {
    await this.close(request.sessionId);
    const listeners = new Set<(event: SessionEvent) => void>();
    const emit = (event: SessionEvent): void => { for (const listener of listeners) listener(event); };
    const controller = new TerminalSessionController({
      hostId: request.profile.hostId,
      terminalId: request.sessionId,
      getSize: () => ({ cols: request.cols, rows: request.rows }),
      webSocketFactory: this.options.webSocketFactory,
      networkAware: true,
      onOutput: (data) => emit({ type: 'data', data: new TextDecoder().decode(data) }),
      onExit: (event) => emit({ type: 'exit', code: event.code, ...(event.signal === undefined ? {} : { signal: event.signal }) }),
      onSnapshot: (snapshot) => {
        const diagnostic = snapshot.diagnostics.at(-1);
        if (diagnostic) emit({ type: 'diagnostic', diagnostic });
        if (snapshot.state === 'closed') emit({ type: 'close' });
      }
    });
    const handle: SessionHandle = {
      id: request.sessionId,
      hostId: request.profile.hostId,
      write: (data) => controller.sendInput(data),
      resize: (cols, rows) => controller.resize(cols, rows),
      close: () => controller.close(),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
    };
    this.sessions.set(request.sessionId, { controller, handle });
    controller.connect();
    return handle;
  }

  async reconnect(sessionId: string): Promise<SessionHandle> {
    const managed = this.sessions.get(sessionId);
    if (!managed) throw new AppError('OPERATION_NOT_FOUND');
    managed.controller.reconnect();
    return managed.handle;
  }

  async close(sessionId: string): Promise<void> {
    const managed = this.sessions.get(sessionId);
    if (!managed) return;
    managed.controller.close();
    this.sessions.delete(sessionId);
  }
}

export interface WebAdapters extends CoreRuntime {
  workspace: WorkspaceWebAdapter;
  capabilityAdapter: WebCapabilityAdapter;
  refreshCapabilities: () => Promise<CapabilitySet>;
}

export const createWebAdapters = (options: {
  api?: WebApiClient;
  webSocketFactory?: (url: string) => TerminalSocketLike;
  platformServices?: PlatformServices;
  } = {}): WebAdapters => {
  const client = options.api ?? api;
  const capabilityAdapter = new WebCapabilityAdapter(client as Pick<WebApiClient, 'getCapabilities'>);
  const accountAdapter = hasAccountApi(client) ? new WebAccountSession(client) : undefined;
  const deviceAdapter = hasDeviceApi(client) ? new WebDeviceTrust(client) : undefined;
  const syncAdapter = hasSyncApi(client) ? new WebSync(client) : undefined;
  const vaultRecoveryAdapter = hasVaultRecoveryApi(client) ? new WebVaultRecovery(client) : undefined;
  const browserSystemServices = createBrowserSystemServices();
  const platformServices = options.platformServices ?? {
    clipboard: browserSystemServices.capabilities.clipboardRead || browserSystemServices.capabilities.clipboardWrite
      ? browserSystemServices.clipboard
      : undefined,
    fileSave: browserSystemServices.capabilities.fileSave ? browserSystemServices.fileSave : undefined,
    notifications: browserSystemServices.capabilities.notifications ? browserSystemServices.notifications : undefined
  } satisfies PlatformServices;
  const runtime = {
    platform: 'web',
    capabilities: createWebCapabilitySet({ maxWorkspacePanes: WEB_PLATFORM_MAX_PANES }),
    platformServices,
    vault: new WebVaultSession(client as Pick<WebApiClient, 'getSetupStatus'>),
    vaultRecovery: undefined,
    connection: new WebConnectionProbe(client as Pick<WebApiClient, 'testConnection'>),
    workspace: createWorkspaceWebAdapter(client),
    sessions: new WebSessionTransport({ webSocketFactory: options.webSocketFactory }),
    files: new WebFileTransport(client),
    commands: new WebCommandTransport(client),
    hosts: new WebHostStore(client as Pick<WebApiClient, 'listHosts' | 'getHost'>),
    identities: new WebIdentityStore(client as Pick<WebApiClient, 'listIdentities'>),
    groups: new WebGroupStore(client as Pick<WebApiClient, 'listGroups'>),
    secrets: new WebSecretStore(),
    snippets: new WebSnippetStore(client as Pick<WebApiClient, 'listSnippets'>),
    activity: new WebActivityStore(client as Pick<WebApiClient, 'listAuditEvents'>),
    imports: new WebImportExportAdapter(client as Pick<WebApiClient, 'previewExternalImport' | 'applyExternalImport' | 'exportOpenSshConfig' | 'exportSshCsv' | 'exportVaultBundle' | 'previewVaultImport' | 'applyVaultImport'>),
    account: undefined,
    devices: undefined,
    sync: undefined,
    capabilityAdapter,
    negotiateCapabilities: async (): Promise<CapabilitySet> => {
      runtime.capabilities = await capabilityAdapter.load();
      runtime.account = runtime.capabilities.supports('account.auth') ? accountAdapter : undefined;
      runtime.devices = runtime.capabilities.supports('device.trust') ? deviceAdapter : undefined;
      runtime.sync = runtime.capabilities.supports('sync.encrypted') ? syncAdapter : undefined;
      runtime.vaultRecovery = runtime.capabilities.supports('sync.encrypted') ? vaultRecoveryAdapter : undefined;
      return runtime.capabilities;
    },
    refreshCapabilities: async (): Promise<CapabilitySet> => runtime.negotiateCapabilities()
  } as WebAdapters;
  return runtime;
};

export const webAdapters = createWebAdapters();
