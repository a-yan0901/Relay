export type ClientPlatform = 'web' | 'desktop' | 'android';

export type AuthType = 'password' | 'private_key';

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

export type WorkspaceLayoutMode = 'single' | 'vertical' | 'horizontal';

export interface WorkspaceTab {
  id: string;
  hostId: string;
  title?: string;
}

export interface WorkspaceLayout {
  mode: WorkspaceLayoutMode;
  ratio: number;
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
export type TransferStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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
}

export type CommandTargetStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

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
  command: string;
  hostIds: readonly string[];
  persistOutput: boolean;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  targets: readonly CommandTargetResult[];
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

export type Capability =
  | 'workspace.persistence'
  | 'vault.bundle'
  | 'ssh.shell'
  | 'ssh.reconnect'
  | 'ssh.proxy-jump'
  | 'sftp.browse'
  | 'sftp.transfer'
  | 'automation.snippets'
  | 'automation.batch-exec'
  | 'audit.activity';

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
