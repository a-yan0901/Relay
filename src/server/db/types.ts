import type { ActivityStatus, ClientPlatform, ConnectionProfileOverrides, GroupNode, TransferJob, TransferStatus, TransferKind, WorkspaceState } from '../../shared/core/models.js';
import type { ConnectionProfileSettings, HostCredentialInput, HostMetadata } from '../../shared/validation.js';
import type { VaultConfig } from '../vault/types.js';

export interface AppConfigRow {
  id: 1;
  schemaVersion: number;
  vaultConfig: VaultConfig;
  createdAt: string;
  updatedAt: string;
}

export interface AccountRow {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountCreateRow {
  id: string;
  email: string;
  passwordHash: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface AccountDeviceRow {
  id: string;
  accountId: string;
  label: string;
  platform: ClientPlatform;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface AccountDeviceCreateRow {
  id: string;
  accountId: string;
  label: string;
  platform: ClientPlatform;
  createdAt?: string;
}

export interface HostRow extends HostMetadata {
  ownerId: string;
  credentialCiphertext: string | null;
  credentialVersion: number;
}

export interface HostCreateRow {
  id?: string;
  ownerId: string;
  name: string;
  address: string;
  port: number;
  username: string;
  authType: HostCredentialInput['type'];
  credentialCiphertext: string | null;
  credentialVersion: number;
  credentialSource?: 'inline' | 'identity' | 'group';
  identityId?: string | null;
  hostKeyAlgorithm: string | null;
  hostKeyFingerprint: string | null;
  groupId: string | null;
  tags: string[];
  isFavorite: boolean;
  lastConnectedAt: string | null;
  jumpHostIds?: string[];
  connectionProfile?: ConnectionProfileSettings;
  connectionProfileOverrides?: ConnectionProfileOverrides | null;
}

export interface HostPatch extends Partial<Pick<HostRow,
  | 'name'
  | 'address'
  | 'port'
  | 'username'
  | 'authType'
  | 'credentialCiphertext'
  | 'credentialVersion'
  | 'hostKeyAlgorithm'
  | 'hostKeyFingerprint'
  | 'groupId'
  | 'tags'
  | 'isFavorite'
  | 'lastConnectedAt'
  | 'jumpHostIds'
  | 'connectionProfile'
  | 'connectionProfileOverrides'
>> {
  credentialSource?: 'inline' | 'identity' | 'group';
  identityId?: string | null;
}

export interface HostFilter {
  query?: string;
  groupId?: string | null;
  favorite?: boolean;
}

export interface GroupRow extends GroupNode {
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export type GroupCreateInput = {
  name: string;
  parentId?: string | null;
  sortOrder?: number;
  defaultIdentityId?: string | null;
  connectionProfile?: ConnectionProfileOverrides | null;
  id?: string;
};

export type GroupPatch = Partial<Pick<GroupRow, 'name' | 'parentId' | 'sortOrder' | 'defaultIdentityId' | 'connectionProfile'>>;

export interface IdentityRow {
  ownerId: string;
  id: string;
  name: string;
  type: 'password' | 'private_key';
  username: string;
  keyFingerprint: string | null;
  credentialCiphertext: string;
  credentialVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface IdentityCreateRow extends IdentityRow {}
export type IdentityPatch = Partial<Pick<IdentityRow, 'name' | 'type' | 'username' | 'keyFingerprint' | 'credentialCiphertext' | 'credentialVersion' | 'updatedAt'>>;

export interface AuditEventInput {
  eventType: string;
  hostId?: string | null;
  requestId: string;
  remoteAddress?: string | null;
  metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditEventRow extends AuditEventInput {
  id: string;
  ownerId: string;
  hostId: string | null;
  remoteAddress: string | null;
  metadata: Readonly<Record<string, string | number | boolean | null>>;
  createdAt: string;
}

export type AuditMetadata = Readonly<Record<string, string | number | boolean | null>>;

export interface AuditCursor {
  createdAt: string;
  id: string;
  sequence?: number;
}

export interface AuditListFilter {
  cursor?: AuditCursor;
  limit?: number;
  eventType?: string;
  hostId?: string;
  requestId?: string;
  status?: ActivityStatus;
  from?: string;
  to?: string;
}

export interface WorkspaceSnapshot {
  ownerId: string;
  version: number;
  state: WorkspaceState;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceTemplate {
  ownerId: string;
  id: string;
  name: string;
  state: WorkspaceState;
  createdAt: string;
  updatedAt: string;
}

export interface SnippetRow {
  ownerId: string;
  id: string;
  name: string;
  description: string | null;
  tags: string[];
  commandCiphertext: string;
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CommandRunRow {
  ownerId: string;
  id: string;
  commandCiphertext: string;
  hostIds: string[];
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  persistOutput: boolean;
  createdAt: string;
  finishedAt: string | null;
}

export interface CommandRunTargetRow {
  ownerId: string;
  runId: string;
  hostId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  exitCode: number | null;
  outputCiphertext: string | null;
  outputBytes: number;
  outputTruncated: boolean;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TransferJobRow extends TransferJob {
  ownerId: string;
  temporaryPath: string | null;
}

export type TransferJobPatch = Partial<Pick<TransferJob, 'status' | 'completedBytes' | 'totalBytes' | 'updatedAt'>> & {
  errorCode?: string | null;
  checkpointOffset?: number;
  checkpointChecksum?: string | null;
  temporaryPath?: string | null;
};

export interface TransferJobCreateRow {
  ownerId: string;
  id: string;
  kind: TransferKind;
  hostId: string;
  sourcePath: string;
  targetPath: string;
  status: TransferStatus;
  completedBytes: number;
  totalBytes: number | null;
  errorCode?: string;
  checkpointOffset?: number;
  checkpointChecksum?: string | null;
  temporaryPath?: string | null;
  createdAt: string;
  updatedAt: string;
}
