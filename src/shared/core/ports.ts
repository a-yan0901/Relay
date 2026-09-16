import type {
  ActivityFilter,
  ActivityPage,
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
  TransferResumeRequest,
  TransferRequest,
  OperationDiagnostic
} from './models.js';
import type {
  GroupPatchInput,
  GroupMutationInput,
  HostCreateInput,
  HostMetadata,
  HostPatchInput,
  IdentityCreateInput,
  IdentityUpdateInput,
  SnippetInput,
  SnippetPatchInput
} from '../validation.js';
import type {
  ExportOptions,
  ImportApplyRequest,
  ImportApplyResult,
  ImportFormat,
  ImportPreview,
  ImportSourceFile,
  VaultBundleApplyResult,
  VaultBundlePreview,
  VaultBundleResolution
} from '../import/types.js';
import type { WorkspaceState, WorkspaceTemplate, WorkspaceTemplateInput, VaultStatus } from './models.js';

export type SecretRef =
  | { kind: 'host'; id: string }
  | { kind: 'identity'; id: string };

export type ByteStream = AsyncIterable<Uint8Array>;

export interface BinarySource {
  name: string;
  size: number | null;
  stream(): ByteStream;
}

export interface SessionEvent {
  type: 'data' | 'stderr' | 'exit' | 'close' | 'diagnostic';
  data?: string;
  code?: number | null;
  signal?: string;
  diagnostic?: OperationDiagnostic;
}

export interface OpenShellRequest {
  sessionId: string;
  profile: ConnectionProfile;
  cols: number;
  rows: number;
  term?: string;
}

export interface SessionHandle {
  id: string;
  hostId: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
  subscribe(listener: (event: SessionEvent) => void): () => void;
}

export interface HostStore {
  list(filter?: HostListFilter): Promise<readonly HostMetadata[]>;
  get(id: string): Promise<HostMetadata | null>;
  listProfiles(): Promise<readonly ConnectionProfile[]>;
  getProfile(hostId: string): Promise<ConnectionProfile | null>;
  create(input: HostCreateInput): Promise<HostMetadata>;
  update(id: string, input: HostPatchInput): Promise<HostMetadata>;
  delete(id: string): Promise<void>;
  clearHostKey(id: string): Promise<void>;
}

export interface SecretStore<Secret = unknown> {
  get(ref: SecretRef): Promise<Secret | null>;
  set(ref: SecretRef, secret: Secret): Promise<void>;
  remove(ref: SecretRef): Promise<void>;
}

export interface VaultSessionPort {
  status(): Promise<VaultStatus>;
  setup(masterPassword: string): Promise<VaultStatus>;
  unlock(masterPassword: string): Promise<VaultStatus>;
  lock(): Promise<void>;
}

export interface ConnectionProbe {
  test(hostId: string): Promise<ConnectionTestResult>;
}

export interface IdentityStore {
  list(): Promise<readonly IdentityMetadata[]>;
  get(id: string): Promise<IdentityMetadata | null>;
  create(input: IdentityCreateInput): Promise<IdentityMetadata>;
  update(id: string, input: IdentityUpdateInput): Promise<IdentityMetadata>;
  delete(id: string): Promise<void>;
}

export interface GroupStore {
  list(): Promise<readonly GroupNode[]>;
  get(id: string): Promise<GroupNode | null>;
  create(input: GroupMutationInput): Promise<GroupNode>;
  update(id: string, input: GroupPatchInput): Promise<GroupNode>;
  delete(id: string): Promise<void>;
}

export interface WorkspaceStore {
  load(): Promise<WorkspaceState>;
  save(expectedVersion: number, state: WorkspaceState): Promise<WorkspaceState>;
  listTemplates(): Promise<readonly WorkspaceTemplate[]>;
  createTemplate(input: WorkspaceTemplateInput): Promise<WorkspaceTemplate>;
  deleteTemplate(templateId: string): Promise<void>;
}

export interface SnippetStore {
  list(): Promise<readonly SnippetMetadata[]>;
  get(id: string): Promise<Snippet | null>;
  create(input: SnippetInput): Promise<Snippet>;
  update(id: string, input: SnippetPatchInput): Promise<Snippet>;
  delete(id: string): Promise<void>;
}

export interface ActivityStore {
  list(filter?: ActivityFilter): Promise<ActivityPage>;
}

export interface ImportExportPort {
  previewExternalImport(files: readonly ImportSourceFile[], formatHint?: ImportFormat): Promise<ImportPreview>;
  applyExternalImport(previewId: string, input: ImportApplyRequest): Promise<ImportApplyResult>;
  exportOpenSshConfig(): Promise<Uint8Array>;
  exportCsv(options?: ExportOptions): Promise<Uint8Array>;
  exportVaultBundle(exportPassword: string): Promise<string>;
  previewVaultImport(exportPassword: string, bundle: string): Promise<VaultBundlePreview>;
  applyVaultImport(previewId: string, resolution: VaultBundleResolution): Promise<VaultBundleApplyResult>;
}

export interface SessionTransport {
  openShell(request: OpenShellRequest): Promise<SessionHandle>;
  reconnect(sessionId: string): Promise<SessionHandle>;
  close(sessionId: string): Promise<void>;
}

export interface FileTransport {
  list(hostId: string, path: string): Promise<readonly SftpEntry[]>;
  createDirectory(hostId: string, path: string): Promise<void>;
  rename(hostId: string, from: string, to: string): Promise<void>;
  remove(hostId: string, path: string): Promise<void>;
  createTransfer(request: TransferRequest): Promise<TransferJob>;
  listTransfers(): Promise<readonly TransferJob[]>;
  getTransfer(transferId: string): Promise<TransferJob | null>;
  upload(transferId: string, source: BinarySource, resume?: TransferResumeRequest): Promise<TransferJob>;
  download(transferId: string, resume?: TransferResumeRequest): Promise<ByteStream>;
  pauseTransfer(transferId: string): Promise<void>;
  cancelTransfer(transferId: string): Promise<void>;
  retryTransfer(transferId: string): Promise<TransferJob>;
}

export interface CommandTransport {
  start(request: CommandRunRequest): Promise<CommandRun>;
  get(runId: string): Promise<CommandRun | null>;
  cancel(runId: string): Promise<void>;
}
