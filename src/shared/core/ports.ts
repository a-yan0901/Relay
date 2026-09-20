import type { TerminalProfile } from '../terminal-appearance.js';
import type {
  AccountSession,
  ActivityFilter,
  ActivityPage,
  CommandRun,
  CommandRunRequest,
  ConnectionTestResult,
  ConnectionProfile,
  DeviceDescriptor,
  GroupNode,
  HostListFilter,
  IdentityMetadata,
  SftpEntry,
  SftpListOptions,
  SftpListPage,
  Snippet,
  SnippetMetadata,
  SyncConflictExport,
  SyncDescriptor,
  SyncEnvelope,
  SyncHead,
  SyncPreview,
  SyncResolution,
  SyncStatus,
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
import type { RecoveryKeyState, VaultRecoveryPreview, WorkspaceState, WorkspaceTemplate, WorkspaceTemplateInput, VaultStatus } from './models.js';
import type { AccountDeletionState, SyncDeletionState } from './models.js';
import type { AccountDeletionConfirmation, CloudSyncDeletionConfirmation } from './account-sync.js';
import type { CloudWorkspaceDirectorySnapshot } from '../cloud/directory.js';
import type { CloudSnapshotHead } from '../cloud/client.js';
import type { RemoteWorkspaceSession } from '../cloud/remote-workspace.js';

export type SecretRef =
  | { kind: 'host'; id: string }
  | { kind: 'identity'; id: string };

export type ByteStream = AsyncIterable<Uint8Array>;

export interface BinarySource {
  name: string;
  size: number | null;
  stream(): ByteStream;
}

/** An opaque platform-owned file selection; the URI and stream stay native. */
export interface NativeUploadSource {
  sourceId: string;
  name: string;
  size: number | null;
}

export type NotificationPermission = 'default' | 'granted' | 'denied';

export interface NotificationRequest {
  title: string;
  body: string;
  tag?: string;
}

/** Synchronous, non-secret storage owned by the current platform shell. */
export interface StoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface NotificationPort {
  permission(): Promise<NotificationPermission>;
  requestPermission(): Promise<NotificationPermission>;
  notify(request: NotificationRequest): Promise<void>;
}

export interface ClipboardPort {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  canRead?: boolean;
  canWrite?: boolean;
}

export interface DialogPort {
  confirm(message: string): Promise<boolean>;
}

export interface ExternalLinkPort {
  open(url: string): Promise<void>;
}

export interface DownloadRequest {
  url: string;
  name: string;
}

export interface DownloadPort {
  download(request: DownloadRequest): Promise<void>;
}

export interface FileSaveRequest {
  name: string;
  content: Uint8Array;
  mimeType: string;
}

export interface FileSavePort {
  save(request: FileSaveRequest): Promise<void>;
}

export interface FileWriter {
  write(data: Uint8Array): Promise<void>;
  seek?(position: number): Promise<void>;
  close(): Promise<void>;
  cancel?(): Promise<void>;
}

/**
 * Opens a platform-owned file sink. Implementations must consume data in
 * bounded chunks and must not retain the complete file in memory.
 */
export interface FileWriterPort {
  open(request: Pick<FileSaveRequest, 'name' | 'mimeType'>): Promise<FileWriter | null>;
}

/** Optional system capabilities supplied by a platform shell. */
export interface PlatformServices {
  /** UI preferences are local-only and must not be treated as cloud state. */
  preferences?: StoragePort;
  /** Browser session recovery intent; native shells may intentionally omit it. */
  session?: StoragePort;
  clipboard?: ClipboardPort;
  dialogs?: DialogPort;
  externalLinks?: ExternalLinkPort;
  downloads?: DownloadPort;
  fileSave?: FileSavePort;
  fileWriter?: FileWriterPort;
  /** User-triggered sharing of a single remote file, when the native shell provides it. */
  shareWriter?: FileWriterPort;
  notifications?: NotificationPort;
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

export interface TerminalProfileStore {
  list(): Promise<readonly TerminalProfile[]>;
  getDefault(): Promise<TerminalProfile>;
  create(input: unknown): Promise<TerminalProfile>;
  setDefault(profileId: string): Promise<TerminalProfile>;
  delete(profileId: string): Promise<void>;
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

export type VaultRecoveryInput =
  | { method: 'master-password'; secret: string }
  | { method: 'recovery-key'; secret: string };

export interface VaultRecoveryPort {
  preview(input: VaultRecoveryInput): Promise<VaultRecoveryPreview>;
  apply(previewId: string, input: VaultRecoveryInput): Promise<VaultStatus>;
}

export interface AccountSessionPort {
  status(): Promise<AccountSession | null>;
  register(email: string, password: string, label?: string): Promise<AccountSession>;
  signIn(email: string, password: string, label?: string): Promise<AccountSession>;
  signOut(): Promise<void>;
  /** Optional until all platform adapters expose the account-deletion lifecycle. */
  reauthenticate?(password: string): Promise<void>;
  getDeletion?(): Promise<AccountDeletionState | null>;
  requestDeletion?(confirmDelete: AccountDeletionConfirmation): Promise<AccountDeletionState>;
  restoreDeletion?(): Promise<void>;
}

export interface DeviceTrustPort {
  listDevices(): Promise<readonly DeviceDescriptor[]>;
  revokeDevice(deviceId: string): Promise<void>;
}

/**
 * Delivers a recovery key exactly once to the active UI/secure presentation.
 * The key is intentionally not part of any shared state or DTO.
 */
export type RecoveryKeyReveal = (recoveryKey: string, keyVersion: number) => void;

export interface SyncPort {
  status(): Promise<{ sync: SyncStatus; head: SyncHead | null; pendingCount?: number; lastErrorCode?: string; recovery?: RecoveryKeyState; deletion?: SyncDeletionState }>;
  descriptor(): Promise<SyncDescriptor | null>;
  pull(): Promise<SyncEnvelope | null>;
  push(envelope: SyncEnvelope, idempotencyKey: string): Promise<SyncHead>;
  previewPull(): Promise<SyncPreview>;
  exportConflict(conflictId: string, exportPassword: string): Promise<SyncConflictExport>;
  resolveConflict(conflictId: string, resolution: SyncResolution): Promise<void>;
  enable(): Promise<SyncHead>;
  issueRecoveryKey(reveal: RecoveryKeyReveal): Promise<RecoveryKeyState>;
  confirmRecoveryKey(recoveryKey: string): Promise<RecoveryKeyState>;
  retry(): Promise<void>;
  /** Optional until all platform adapters expose cloud deletion lifecycle controls. */
  requestCloudDeletion?(confirmDelete: CloudSyncDeletionConfirmation): Promise<SyncDeletionState>;
  restoreCloudDeletion?(): Promise<void>;
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

/** Optional account-scoped directory of independent device workspaces. */
export interface WorkspaceDirectoryPort {
  refresh(): Promise<CloudWorkspaceDirectorySnapshot>;
}

/** Opens an independent device workspace through the authenticated client. */
export interface RemoteWorkspacePort {
  open(workspaceId: string, ownerDeviceId: string): Promise<RemoteWorkspaceSession>;
}

export interface CloudSyncResult {
  status: 'initialized' | 'pulled' | 'pushed' | 'synced' | 'conflict';
  head: CloudSnapshotHead | null;
}

/** Account-level cloud configuration sync; device workspace state is separate. */
export interface CloudSyncPort {
  sync(): Promise<CloudSyncResult>;
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
  /** Native shells may stream directly to a file writer to avoid renderer aggregation. */
  exportVaultBundleStream?: (exportPassword: string) => Promise<AsyncIterable<Uint8Array>>;
  previewVaultImport(exportPassword: string, bundle: string): Promise<VaultBundlePreview>;
  applyVaultImport(previewId: string, resolution: VaultBundleResolution): Promise<VaultBundleApplyResult>;
}

export interface SessionTransport {
  openShell(request: OpenShellRequest): Promise<SessionHandle>;
  reconnect(sessionId: string): Promise<SessionHandle>;
  close(sessionId: string): Promise<void>;
}

export interface FileTransport {
  /** Paths are normalized/validated by the adapter and never treated as local paths. */
  list(hostId: string, path: string): Promise<readonly SftpEntry[]>;
  /** Optional bounded listing used by large-directory UIs. */
  listPage?(hostId: string, path: string, options?: SftpListOptions): Promise<SftpListPage>;
  createDirectory(hostId: string, path: string): Promise<void>;
  rename(hostId: string, from: string, to: string): Promise<void>;
  remove(hostId: string, path: string): Promise<void>;
  createTransfer(request: TransferRequest): Promise<TransferJob>;
  listTransfers(): Promise<readonly TransferJob[]>;
  getTransfer(transferId: string): Promise<TransferJob | null>;
  /** Resume arguments are optional so clients without `transfer.resume` can use a fresh transfer. */
  upload(transferId: string, source: BinarySource, resume?: TransferResumeRequest): Promise<TransferJob>;
  /** Native clients may keep the selected URI and stream it without exposing file bytes to the WebView. */
  pickUploadSource?(): Promise<NativeUploadSource | null>;
  uploadFromSource?(transferId: string, source: NativeUploadSource, resume?: TransferResumeRequest): Promise<TransferJob>;
  /** Release a selected native source that was not consumed by an upload. */
  releaseUploadSource?(source: NativeUploadSource): Promise<void>;
  download(transferId: string, resume?: TransferResumeRequest): Promise<ByteStream>;
  /** Optional browser fallback when no user-selected streaming writer exists. */
  directDownload?(transferId: string, name: string): Promise<void>;
  pauseTransfer(transferId: string): Promise<void>;
  cancelTransfer(transferId: string): Promise<void>;
  retryTransfer(transferId: string): Promise<TransferJob>;
}

export interface CommandTransport {
  start(request: CommandRunRequest): Promise<CommandRun>;
  get(runId: string): Promise<CommandRun | null>;
  cancel(runId: string): Promise<void>;
}
