export type ClientPlatform = 'web' | 'desktop' | 'android';

export type AuthType = 'password' | 'private_key';
export type IdentityType = AuthType;

export type VaultPhase = 'uninitialized' | 'locked' | 'unlocked';

export interface VaultStatus {
  phase: VaultPhase;
}

export type AccountState = 'signed-out' | 'authenticating' | 'signed-in' | 'revoked';

export type SyncStatus =
  | 'local-only'
  | 'needs-unlock'
  | 'syncing'
  | 'synced'
  | 'pending'
  | 'offline'
  | 'conflict'
  | 'device-revoked';

export interface AccountSession {
  accountId: string;
  deviceId: string;
  state: Exclude<AccountState, 'signed-out' | 'authenticating'>;
  expiresAt: string;
}

export interface DeviceDescriptor {
  id: string;
  label: string;
  platform: ClientPlatform;
  lastSeenAt: string | null;
  current: boolean;
  revokedAt: string | null;
}

export interface SyncHead {
  vaultId: string;
  revision: number;
  keyVersion: number;
  payloadHash: string;
  updatedAt: string;
}

export interface WrappedKeyEnvelope {
  version: number;
  nonce: string;
  ciphertext: string;
  authTag: string;
  aad: string;
}

export interface VaultUnlockEnvelope {
  version: number;
  kdf: {
    algorithm: string;
    salt: string;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
    hashLength: number;
  };
  wrappedVaultKey: WrappedKeyEnvelope;
  recoveryWrappedVaultKey?: WrappedKeyEnvelope;
}

export interface SyncDescriptor {
  vaultId: string;
  keyVersion: number;
  vaultUnlockEnvelope: VaultUnlockEnvelope;
  wrappedSyncKey: WrappedKeyEnvelope;
}

export interface SyncEnvelope {
  schemaVersion: number;
  vaultId: string;
  revision: number;
  parentRevision: number | null;
  deviceId: string;
  keyVersion: number;
  nonce: string;
  ciphertext: string;
  authTag: string;
  aad: string;
  payloadHash: string;
  byteLength: number;
}

export interface SyncPreview {
  conflictId: string;
  localRevision: number;
  remoteRevision: number;
  conflictTypes: readonly ('host' | 'group' | 'identity' | 'snippet' | 'workspace' | 'host-key')[];
  localBackupRevision: number;
}

export type SyncResolution = 'keep-local' | 'use-remote' | 'export-both';

export interface SyncState {
  sync: SyncStatus;
  head: SyncHead | null;
  pendingCount: number;
  lastErrorCode?: string;
  lastSyncedAt?: string;
  deletion?: {
    deleteAfter: string;
    requestedAt: string;
    remainingMs: number;
  };
}

export interface ReconnectPolicy {
  enabled: boolean;
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export interface ConnectionProfile {
  hostId: string;
  address: string;
  port: number;
  username: string;
  authType: AuthType;
  jumpHostIds: readonly string[];
  keepaliveIntervalMs: number;
  keepaliveCountMax: number;
  reconnect: ReconnectPolicy;
  hostKeyAlgorithm: string | null;
  hostKeyFingerprint: string | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  hostKey?: {
    algorithm: string;
    fingerprint: string;
    address: string;
    port: number;
    reason?: 'first-seen' | 'changed';
    previous?: {
      algorithm: string;
      fingerprint: string;
    };
  };
}

export interface HostListFilter {
  query?: string;
  groupId?: string | null;
  favorite?: boolean;
  tags?: readonly string[];
}

export type IdentitySource = 'host' | 'group' | 'none';

export type TargetSelectionSource = 'servers' | 'workspace' | 'group' | 'tag' | 'favorites' | 'recent';

export interface TargetSelection {
  hostIds: readonly string[];
  groupIds: readonly string[];
  favoriteOnly: boolean;
  query: string;
  source?: TargetSelectionSource;
}

export interface TargetSelectionSnapshot {
  hostIds: readonly string[];
  source: TargetSelectionSource;
  capturedAt: string;
  displayNames: readonly string[];
}

export interface BroadcastTargetSnapshot {
  workspaceId: string | null;
  tabIds: readonly string[];
  hostIds: readonly string[];
  capturedAt: string;
  highRisk: boolean;
}

export interface IdentityMetadata {
  id: string;
  name: string;
  type: IdentityType;
  username: string;
  keyFingerprint: string | null;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionProfileOverrides {
  keepaliveIntervalMs?: number;
  keepaliveCountMax?: number;
  reconnect?: Partial<ReconnectPolicy>;
}

export interface GroupNode {
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
  defaultIdentityId: string | null;
  connectionProfile: ConnectionProfileOverrides | null;
}

export type WorkspaceLayoutMode = 'single' | 'vertical' | 'horizontal' | 'grid';

export interface WorkspaceTab {
  id: string;
  hostId: string;
  title?: string;
}

export interface WorkspaceLayout {
  mode: WorkspaceLayoutMode;
  ratio: number;
  paneTabIds?: readonly string[];
}

export interface WorkspaceFilters {
  query: string;
  groupId: string | null;
  favoriteOnly: boolean;
}

export interface WorkspaceState {
  version: number;
  tabs: readonly WorkspaceTab[];
  activeTabId: string | null;
  layout: WorkspaceLayout;
  filters: WorkspaceFilters;
}

export interface WorkspaceTemplate {
  id: string;
  name: string;
  state: WorkspaceState;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTemplateInput {
  name: string;
  state: WorkspaceState;
}

export type SftpEntryType = 'file' | 'directory' | 'symlink' | 'other';

export interface SftpEntry {
  name: string;
  path: string;
  type: SftpEntryType;
  size: number;
  mode: number | null;
  modifiedAt: string | null;
}

export type TransferKind = 'upload' | 'download';
export type TransferStatus = 'queued' | 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface TransferCheckpoint {
  transferId: string;
  offset: number;
  totalBytes: number | null;
  checksum: string | null;
}

export interface TransferResumeRequest {
  transferId: string;
  expectedOffset: number;
  checksum: string | null;
}

export interface TransferJob {
 id: string;
 kind: TransferKind;
 hostId: string;
 sourcePath: string;
 targetPath: string;
 status: TransferStatus;
 completedBytes: number;
 totalBytes: number | null;
 errorCode?: string;
 checkpoint?: TransferCheckpoint;
 speedBytesPerSecond?: number;
 etaSeconds?: number | null;
 createdAt: string;
 updatedAt: string;
}

export interface TransferRequest {
  kind: TransferKind;
  hostId: string;
  sourcePath: string;
  targetPath: string;
  totalBytes?: number | null;
}

export interface SnippetMetadata {
  id: string;
  name: string;
  description: string | null;
  tags: readonly string[];
  createdAt: string;
  updatedAt: string;
}

export interface Snippet extends SnippetMetadata {
  command: string;
  variables: readonly string[];
}

export interface CommandRunRequest {
  command: string;
  hostIds: readonly string[];
  variables: Readonly<Record<string, string>>;
  concurrency: number;
  timeoutMs: number;
  persistOutput: boolean;
  confirmed?: boolean;
  targetSelection?: TargetSelectionSnapshot;
}

export type CommandTargetStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export interface CommandRunSummary {
  total: number;
  queued: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
  interrupted: number;
  anomalyCount: number;
  truncatedCount: number;
}

export interface CommandTargetResult {
 hostId: string;
 status: CommandTargetStatus;
 exitCode: number | null;
 output: string;
 outputBytes: number;
 truncated?: boolean;
 errorCode?: string;
 startedAt?: string;
 finishedAt?: string;
}

export interface CommandRun {
  id: string;
  requestId?: string;
  command: string;
  hostIds: readonly string[];
  persistOutput: boolean;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  targets: readonly CommandTargetResult[];
  targetSelection?: TargetSelectionSnapshot;
  summary?: CommandRunSummary;
  createdAt: string;
  finishedAt?: string;
}

export interface AuditEvent {
  id: string;
  ownerId: string;
  eventType: string;
  hostId: string | null;
  requestId: string;
  remoteAddress: string | null;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
  createdAt: string;
}

export const activityStatuses = ['queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted'] as const;
export type ActivityStatus = typeof activityStatuses[number];

export const isActivityStatus = (value: unknown): value is ActivityStatus => typeof value === 'string' && activityStatuses.includes(value as ActivityStatus);

export const activityStatusFromEvent = (event: Pick<AuditEvent, 'eventType' | 'metadata'>): ActivityStatus => {
  const explicit = event.metadata.status;
  if (isActivityStatus(explicit)) return explicit;
  if (event.eventType === 'command_run_summary') {
    const numeric = (key: string): number => typeof event.metadata[key] === 'number' ? event.metadata[key] as number : 0;
    if (numeric('failureCount') > 0) return 'failed';
    if (numeric('interruptedCount') > 0) return 'interrupted';
    if (numeric('cancelledCount') > 0) return 'cancelled';
    return 'succeeded';
  }
  if (event.eventType.endsWith('_queued')) return 'queued';
  if (event.eventType.endsWith('_started') || event.eventType.endsWith('_running')) return 'running';
  if (event.eventType.endsWith('_failed')) return 'failed';
  if (event.eventType.endsWith('_cancelled')) return 'cancelled';
  if (event.eventType.endsWith('_interrupted')) return 'interrupted';
  return 'succeeded';
};

export interface ActivityFilter {
  cursor?: string;
  limit?: number;
  eventType?: string;
  hostId?: string;
  requestId?: string;
  status?: ActivityStatus;
  from?: string;
  to?: string;
}

export interface ActivityPage {
  items: readonly AuditEvent[];
  nextCursor?: string;
}

export type ConnectionStage = 'resolve' | 'tcp' | 'jump' | 'host-key' | 'authentication' | 'channel';
export type ConnectionDiagnosticStatus = 'started' | 'succeeded' | 'failed';

export interface ConnectionDiagnostic {
  id: string;
  hostId: string;
  stage: ConnectionStage;
  status: ConnectionDiagnosticStatus;
  hopIndex: number;
  retryable: boolean;
  code?: string;
  at: string;
}

/**
 * The user-facing lifecycle contract shared by terminal, transfer and command
 * clients. ConnectionDiagnostic remains the low-level SSH adapter event; the
 * server maps it into this stable, platform-neutral shape before publishing it.
 */
export type OperationDiagnosticKind = 'terminal' | 'transfer' | 'command';

export type OperationStage =
  | 'dns'
  | 'tcp'
  | 'jump-host'
  | 'host-key'
  | 'auth'
  | 'pty'
  | 'sftp'
  | 'command';

export type OperationDiagnosticState = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'needs-reopen';

export type OperationNextAction = 'wait' | 'resume' | 'retry' | 'edit-credentials' | 'confirm-host-key' | 'reopen' | 'none';

export interface OperationDiagnostic {
  operationId: string;
  hostId: string;
  kind: OperationDiagnosticKind;
  stage: OperationStage;
  state: OperationDiagnosticState;
  retryable: boolean;
  nextAction: OperationNextAction;
  errorCode?: string;
  requestId?: string;
  startedAt: string;
  endedAt?: string;
}

export type Capability =
  | 'workspace.persistence'
  | 'workspace.templates'
  | 'workspace.multi-pane'
  | 'workspace.max-panes'
  | 'terminal.broadcast'
  | 'transfer.resume'
  | 'sftp.local-files'
  | 'session.reattach'
  | 'forwarding.local'
  | 'account.auth'
  | 'device.trust'
  | 'sync.encrypted'
  | 'vault.bundle'
  | 'vault.identities'
  | 'ssh.shell'
  | 'ssh.reconnect'
  | 'ssh.proxy-jump'
  | 'sftp.browse'
  | 'sftp.transfer'
  | 'sftp.entry-mutations'
  | 'automation.snippets'
  | 'automation.snippet-manager'
  | 'automation.batch-exec'
  | 'automation.target-picker'
  | 'audit.activity'
  | 'session.lifecycle-status';

export const normalizeWorkspaceState = (state: WorkspaceState): WorkspaceState => ({
  ...state,
  layout: {
    ...state.layout,
    ratio: Math.min(0.8, Math.max(0.2, state.layout.ratio))
  }
});

export const validateJumpChain = (
  targetHostId: string,
  profiles: ReadonlyMap<string, Pick<ConnectionProfile, 'jumpHostIds'>>
): readonly string[] => {
  const chain: string[] = [];
  const active = new Set<string>();
  const visited = new Set<string>();

  const visit = (hostId: string): void => {
    if (active.has(hostId)) {
      throw new Error(`Jump host cycle detected at ${hostId}`);
    }
    if (visited.has(hostId)) {
      throw new Error(`Jump host graph repeats ${hostId}`);
    }

    const profile = profiles.get(hostId);
    if (!profile) {
      throw new Error(`Jump host ${hostId} not found`);
    }

    active.add(hostId);
    visited.add(hostId);
    chain.push(hostId);
    for (const jumpHostId of profile.jumpHostIds) {
      visit(jumpHostId);
    }
    active.delete(hostId);
  };

  visit(targetHostId);
  if (chain.length - 1 > 4) {
    throw new Error('A connection path cannot contain more than four jump hosts');
  }
  return chain;
};
