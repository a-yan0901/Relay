import type { HostCredentialInput, HostMetadata } from '../../shared/validation.js';
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
}

export interface AuditEventRow extends AuditEventInput {
  id: string;
  ownerId: string;
  hostId: string | null;
  remoteAddress: string | null;
  createdAt: string;
}
