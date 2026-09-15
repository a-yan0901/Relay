import type { CapabilitySet } from '../../shared/core/capabilities';
import { createWebCapabilitySet } from '../../shared/core/capabilities';
import type {
  CommandRun,
  CommandRunRequest,
  ConnectionProfile,
  SftpEntry,
  TransferJob,
  TransferRequest,
  WorkspaceState
} from '../../shared/core/models';
import type { HostMetadata } from '../../shared/validation';
import { defaultConnectionProfileSettings } from '../../shared/validation';
import type {
  CommandTransport,
  FileTransport,
  HostStore,
  SecretStore,
  SessionEvent,
  SessionHandle,
  SessionTransport,
  OpenShellRequest
} from '../../shared/core/ports';
import { AppError } from '../../shared/errors';
import type { TerminalSocketLike } from '../hooks/use-terminal-session';
import { TerminalSessionController } from '../hooks/use-terminal-session';
import * as api from '../api';
import type { CapabilityResponse, ImportPreviewResponse, ImportResultResponse } from '../api';

const emptyWorkspace = (): WorkspaceState => ({
  version: 0,
  tabs: [],
  activeTabId: null,
  layout: { mode: 'single', ratio: 0.5 },
  filters: { query: '', groupId: null, favoriteOnly: false }
});

export interface WorkspaceWebAdapter {
  load(): Promise<WorkspaceState>;
  save(expectedVersion: number, state: WorkspaceState): Promise<WorkspaceState>;
  exportEncrypted(password: string): Promise<string>;
  previewImport(password: string, bundle: string): Promise<ImportPreviewResponse>;
  applyImport(previewId: string, resolution: { hostConflicts: 'skip' | 'replace'; groupConflicts: 'reuse' | 'replace' }): Promise<ImportResultResponse>;
}

export interface WebApiClient {
  getWorkspace?: typeof api.getWorkspace;
  saveWorkspace?: typeof api.saveWorkspace;
  exportVaultBundle?: typeof api.exportVaultBundle;
  previewVaultImport?: typeof api.previewVaultImport;
  applyVaultImport?: typeof api.applyVaultImport;
  listHosts?: typeof api.listHosts;
  getHost?: typeof api.getHost;
  listSftpEntries?: typeof api.listSftpEntries;
  createTransfer?: typeof api.createTransfer;
  getTransfer?: typeof api.getTransfer;
  uploadTransferContent?: typeof api.uploadTransferContent;
  downloadTransferContent?: typeof api.downloadTransferContent;
  cancelTransfer?: typeof api.cancelTransfer;
  retryTransfer?: typeof api.retryTransfer;
  startCommandRun?: typeof api.startCommandRun;
  getCommandRun?: typeof api.getCommandRun;
  cancelCommandRun?: typeof api.cancelCommandRun;
  getCapabilities?: typeof api.getCapabilities;
}

const requireApi = <T>(value: T | undefined): T => {
  if (!value) throw new AppError('CAPABILITY_UNAVAILABLE');
  return value;
};

export const createWorkspaceWebAdapter = (client: WebApiClient = api): WorkspaceWebAdapter => ({
  load: () => client.getWorkspace?.() ?? Promise.resolve(emptyWorkspace()),
  save: (expectedVersion, state) => client.saveWorkspace?.(expectedVersion, state) ?? Promise.resolve(state),
  exportEncrypted: async (password) => (await requireApi(client.exportVaultBundle)(password)).bundle,
  previewImport: (password, bundle) => requireApi(client.previewVaultImport)(password, bundle),
  applyImport: (previewId, resolution) => requireApi(client.applyVaultImport)(previewId, resolution)
});

export const webWorkspaceAdapter = createWorkspaceWebAdapter();

const profileFromHost = (host: HostMetadata): ConnectionProfile => ({
  hostId: host.id,
  address: host.address,
  port: host.port,
  username: host.username,
  authType: host.authType,
  jumpHostIds: host.jumpHostIds ?? [],
  keepaliveIntervalMs: host.connectionProfile?.keepaliveIntervalMs ?? defaultConnectionProfileSettings().keepaliveIntervalMs,
  keepaliveCountMax: host.connectionProfile?.keepaliveCountMax ?? defaultConnectionProfileSettings().keepaliveCountMax,
  reconnect: host.connectionProfile?.reconnect ?? defaultConnectionProfileSettings().reconnect,
  hostKeyAlgorithm: host.hostKeyAlgorithm,
  hostKeyFingerprint: host.hostKeyFingerprint
});

export class WebHostStore implements HostStore {
  constructor(private readonly client: Pick<WebApiClient, 'listHosts' | 'getHost'> = api) {}

  async listProfiles(): Promise<readonly ConnectionProfile[]> {
    const hosts = await requireApi(this.client.listHosts)();
    return hosts.map(profileFromHost);
  }

  async getProfile(hostId: string): Promise<ConnectionProfile | null> {
    try {
      return profileFromHost(await requireApi(this.client.getHost)(hostId));
    } catch (error) {
      if (error instanceof AppError && error.code === 'HOST_NOT_FOUND') return null;
      throw error;
    }
  }
}

export class WebSecretStore implements SecretStore {
  async get(_hostId: string): Promise<null> {
    return null;
  }

  async set(_hostId: string, _secret: unknown): Promise<void> {
    throw new AppError('CAPABILITY_UNAVAILABLE', 'Web 客户端不在浏览器中保存主机秘密');
  }

  async remove(_hostId: string): Promise<void> {
    throw new AppError('CAPABILITY_UNAVAILABLE', 'Web 客户端不在浏览器中保存主机秘密');
  }
}

export class WebFileTransport implements FileTransport {
  constructor(private readonly client: Pick<WebApiClient, 'listSftpEntries' | 'createTransfer' | 'cancelTransfer'> = api) {}

  list(hostId: string, path: string): Promise<readonly SftpEntry[]> {
    return requireApi(this.client.listSftpEntries)(hostId, path);
  }

  createTransfer(request: TransferRequest): Promise<TransferJob> {
    return requireApi(this.client.createTransfer)(request);
  }

  cancelTransfer(transferId: string): Promise<void> {
    return requireApi(this.client.cancelTransfer)(transferId);
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
    const capabilities = [...new Set(response.capabilities)];
    return { client: 'web', version: 1, capabilities, supports: (capability) => capabilities.includes(capability) };
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

export interface WebAdapters {
  workspace: WorkspaceWebAdapter;
  sessions: SessionTransport;
  files: FileTransport;
  commands: CommandTransport;
  hosts: HostStore;
  secrets: SecretStore;
  capabilities: WebCapabilityAdapter;
}

export const createWebAdapters = (options: { api?: WebApiClient; webSocketFactory?: (url: string) => TerminalSocketLike } = {}): WebAdapters => {
  const client = options.api ?? api;
  return {
    workspace: createWorkspaceWebAdapter(client),
    sessions: new WebSessionTransport({ webSocketFactory: options.webSocketFactory }),
    files: new WebFileTransport(client),
    commands: new WebCommandTransport(client),
    hosts: new WebHostStore(client as Pick<WebApiClient, 'listHosts' | 'getHost'>),
    secrets: new WebSecretStore(),
    capabilities: new WebCapabilityAdapter(client as Pick<WebApiClient, 'getCapabilities'>)
  };
};

export const webAdapters = createWebAdapters();
