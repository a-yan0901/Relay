import type { ConnectionProfileSettings, HostCredentialInput, HostMetadata } from '../../shared/validation.js';
import type { WorkspaceState } from '../../shared/core/models.js';
import type { VaultConfig } from '../vault/types.js';

export interface AppConfigRow {
  id: 1;
  schemaVersion: number;
  vaultConfig: VaultConfig;
  createdAt: string;
  updatedAt: string;
}

export interface HostRow extends HostMetadata {
  ownerId: string;
  credentialCiphertext: string;
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
  credentialCiphertext: string;
  credentialVersion: number;
  hostKeyAlgorithm: string | null;
  hostKeyFingerprint: string | null;
  groupId: string | null;
  tags: string[];
  isFavorite: boolean;
  lastConnectedAt: string | null;
  jumpHostIds?: string[];
  connectionProfile?: ConnectionProfileSettings;
}

export type HostPatch = Partial<Pick<HostRow,
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
>>;

export interface HostFilter {
  query?: string;
  groupId?: string | null;
  favorite?: boolean;
}

export interface GroupRow {
  id: string;
  ownerId: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export type GroupCreateInput = {
  name: string;
  sortOrder?: number;
  id?: string;
};

export type GroupPatch = Partial<Pick<GroupRow, 'name' | 'sortOrder'>>;

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
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  persistOutput: boolean;
  createdAt: string;
  finishedAt: string | null;
}

export interface CommandRunTargetRow {
  ownerId: string;
  runId: string;
  hostId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  exitCode: number | null;
  outputCiphertext: string | null;
  outputBytes: number;
  outputTruncated: boolean;
  errorCode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}
