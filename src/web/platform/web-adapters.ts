import type { CapabilitySet } from '../../shared/core/capabilities';
import { createCapabilitySet, createWebCapabilitySet } from '../../shared/core/capabilities';
import type {
  ActivityFilter,
  CommandRun,
  CommandRunRequest,
  ConnectionTestResult,
  ConnectionProfile,
  GroupNode,
  HostListFilter,
  IdentityMetadata,
  SftpEntry,
  Snippet,
  SnippetMetadata,
  TransferJob,
  TransferRequest,
  WorkspaceState
} from '../../shared/core/models';
import type { GroupPatchInput, HostCreateInput, HostMetadata, HostPatchInput, IdentityCreateInput, IdentityUpdateInput, GroupMutationInput, SnippetInput, SnippetPatchInput } from '../../shared/validation';
import type { ExportOptions, ImportApplyRequest, ImportFormat, ImportPreview, ImportSourceFile, VaultBundleApplyResult, VaultBundlePreview, VaultBundleResolution } from '../../shared/import/types';
import { defaultConnectionProfileSettings } from '../../shared/validation';
import type {
  BinarySource,
  ByteStream,
  CommandTransport,
  ConnectionProbe,
  FileTransport,
  GroupStore,
  HostStore,
  IdentityStore,
  ImportExportPort,
  SecretRef,
  SecretStore,
  SessionEvent,
  SessionHandle,
  SessionTransport,
  SnippetStore,
  VaultSessionPort,
  WorkspaceStore,
  OpenShellRequest
} from '../../shared/core/ports';
import type { CoreRuntime } from '../../shared/core/runtime';
import { AppError } from '../../shared/errors';
import type { TerminalSocketLike } from '../hooks/use-terminal-session';
import { TerminalSessionController } from '../hooks/use-terminal-session';
import * as api from '../api';
import type { CapabilityResponse } from '../api';

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
  downloadTransferContent?: typeof api.downloadTransferContent;
  cancelTransfer?: typeof api.cancelTransfer;
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
}

const requireApi = <T>(value: T | undefined): T => {
  if (!value) throw new AppError('CAPABILITY_UNAVAILABLE');
  return value;
};

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
  constructor(private readonly client: Pick<WebApiClient, 'listHosts' | 'getHost'> & Partial<Pick<WebApiClient, 'createHost' | 'updateHost' | 'deleteHost'>> = api) {}

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

type WebFileClient = Pick<WebApiClient, 'listSftpEntries' | 'createTransfer' | 'cancelTransfer'> & Partial<Pick<WebApiClient, 'listTransfers' | 'getTransfer' | 'mutateSftpEntry' | 'uploadTransferContent' | 'downloadTransferContent' | 'retryTransfer'>>;

const collectBinarySource = async (source: BinarySource): Promise<Blob> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of source.stream()) chunks.push(chunk);
  return new Blob(chunks.map((chunk) => chunk.slice().buffer as ArrayBuffer), { type: 'application/octet-stream' });
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

  async upload(transferId: string, source: BinarySource): Promise<TransferJob> {
    return requireApi(this.client.uploadTransferContent)(transferId, await collectBinarySource(source));
  }

  async download(transferId: string): Promise<ByteStream> {
    const blob = await requireApi(this.client.downloadTransferContent)(transferId);
    return (async function* (): ByteStream {
      yield new Uint8Array(await blob.arrayBuffer());
    })();
  }

  cancelTransfer(transferId: string): Promise<void> {
    return requireApi(this.client.cancelTransfer)(transferId);
  }

  retryTransfer(transferId: string): Promise<TransferJob> {
    return requireApi(this.client.retryTransfer)(transferId);
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

  async list(filter: ActivityFilter = {}): Promise<readonly import('../../shared/core/models').AuditEvent[]> {
    return (await requireApi(this.client.listAuditEvents)(filter)).items;
  }
}

const toWebFile = (source: ImportSourceFile): File => new File([
  typeof source.content === 'string' ? source.content : source.content.slice().buffer as ArrayBuffer
], source.filename);

const blobToBytes = async (blob: Blob): Promise<Uint8Array> => new Uint8Array(await blob.arrayBuffer());

export class WebImportExportAdapter implements ImportExportPort {
  constructor(private readonly client: Pick<WebApiClient, 'previewExternalImport' | 'applyExternalImport' | 'exportOpenSshConfig' | 'exportSshCsv' | 'exportVaultBundle' | 'previewVaultImport' | 'applyVaultImport'> = api) {}

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
  constructor(private readonly client: Pick<WebApiClient, 'getCapabilities'> = api) {}

  async load(): Promise<CapabilitySet> {
    const response = await this.client.getCapabilities?.() ?? { client: 'web', version: 1, capabilities: [...createWebCapabilitySet().capabilities] } satisfies CapabilityResponse;
    if (response.version !== 1 || response.client !== 'web' || !Array.isArray(response.capabilities)) throw new AppError('CAPABILITY_UNAVAILABLE');
    const webCapabilities = createWebCapabilitySet();
    return createCapabilitySet('web', response.capabilities.filter((capability): capability is typeof webCapabilities.capabilities[number] => webCapabilities.supports(capability)));
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
      onOutput: (data) => emit({ type: 'data', data: new TextDecoder().decode(data) }),
      onExit: (event) => emit({ type: 'exit', code: event.code, ...(event.signal === undefined ? {} : { signal: event.signal }) }),
      onSnapshot: (snapshot) => {
        for (const diagnostic of snapshot.diagnostics) emit({ type: 'diagnostic', diagnostic });
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

export const createWebAdapters = (options: { api?: WebApiClient; webSocketFactory?: (url: string) => TerminalSocketLike } = {}): WebAdapters => {
  const client = options.api ?? api;
  const capabilityAdapter = new WebCapabilityAdapter(client as Pick<WebApiClient, 'getCapabilities'>);
  const runtime = {
    platform: 'web',
    capabilities: createWebCapabilitySet(),
    vault: new WebVaultSession(client as Pick<WebApiClient, 'getSetupStatus'>),
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
    capabilityAdapter,
    negotiateCapabilities: async (): Promise<CapabilitySet> => {
      const serverCapabilities = await capabilityAdapter.load();
      const webCapabilities = createWebCapabilitySet();
      runtime.capabilities = createCapabilitySet('web', webCapabilities.capabilities.filter((capability) => serverCapabilities.supports(capability)));
      return runtime.capabilities;
    },
    refreshCapabilities: async (): Promise<CapabilitySet> => runtime.negotiateCapabilities()
  } as WebAdapters;
  return runtime;
};

export const webAdapters = createWebAdapters();
