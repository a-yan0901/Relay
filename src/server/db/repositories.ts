import { randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import type { HostMetadata } from '../../shared/validation.js';
import { ARGON2ID_PARAMS, VAULT_VERSION, type VaultConfig } from '../vault/types.js';
import type { SqliteDatabase } from './database.js';
import {
  type AppConfigRow,
  type AuditEventInput,
  type AuditEventRow,
  type GroupCreateInput,
  type GroupPatch,
  type GroupRow,
  type HostCreateRow,
  type HostFilter,
  type HostPatch,
  type HostRow
} from './types.js';

interface AppConfigSqlRow {
  schema_version: number;
  kdf_algorithm: string;
  kdf_params_json: string;
  kdf_salt: string;
  wrapped_vault_key: string;
  wrapped_vault_key_nonce: string;
  wrapped_vault_key_tag: string;
  wrapped_vault_key_aad: string;
  created_at: string;
  updated_at: string;
}

interface GroupSqlRow {
  id: string;
  owner_id: string;
  name: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface HostSqlRow {
  id: string;
  owner_id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  auth_type: 'password' | 'private_key';
  credential_ciphertext: string;
  credential_version: number;
  host_key_algorithm: string | null;
  host_key_fingerprint: string | null;
  group_id: string | null;
  tags_json: string;
  is_favorite: number;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

type HostMetadataSqlRow = Omit<HostSqlRow, 'credential_ciphertext' | 'credential_version'>;

interface AuditSqlRow {
  id: string;
  owner_id: string;
  event_type: string;
  host_id: string | null;
  request_id: string;
  remote_address: string | null;
  created_at: string;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const assertIdentifier = (value: string, code: 'HOST_VALIDATION_FAILED' | 'INTERNAL_ERROR' = 'INTERNAL_ERROR'): void => {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw new AppError(code);
  }
};

const assertOwner = (ownerId: string): void => assertIdentifier(ownerId);

const now = (): string => new Date().toISOString();

const parseTags = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((tag): tag is string => typeof tag === 'string')) {
      throw new Error('tags must be an array');
    }

    return parsed;
  } catch {
    throw new AppError('INTERNAL_ERROR');
  }
};

const serializeTags = (tags: string[]): string => {
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new AppError('HOST_VALIDATION_FAILED');
  }

  return JSON.stringify(tags);
};

const escapeLike = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

const toGroupRow = (row: GroupSqlRow): GroupRow => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toHostRow = (row: HostSqlRow): HostRow => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  address: row.address,
  port: row.port,
  username: row.username,
  authType: row.auth_type,
  credentialCiphertext: row.credential_ciphertext,
  credentialVersion: row.credential_version,
  hostKeyAlgorithm: row.host_key_algorithm,
  hostKeyFingerprint: row.host_key_fingerprint,
  groupId: row.group_id,
  tags: parseTags(row.tags_json),
  isFavorite: row.is_favorite === 1,
  lastConnectedAt: row.last_connected_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toHostMetadata = (row: HostMetadataSqlRow): HostMetadata => ({
  id: row.id,
  name: row.name,
  address: row.address,
  port: row.port,
  username: row.username,
  authType: row.auth_type,
  hostKeyAlgorithm: row.host_key_algorithm,
  hostKeyFingerprint: row.host_key_fingerprint,
  groupId: row.group_id,
  tags: parseTags(row.tags_json),
  isFavorite: row.is_favorite === 1,
  lastConnectedAt: row.last_connected_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toAuditRow = (row: AuditSqlRow): AuditEventRow => ({
  id: row.id,
  ownerId: row.owner_id,
  eventType: row.event_type,
  hostId: row.host_id,
  requestId: row.request_id,
  remoteAddress: row.remote_address,
  createdAt: row.created_at
});

const parseVaultConfig = (row: AppConfigSqlRow): VaultConfig => {
  try {
    const params: unknown = JSON.parse(row.kdf_params_json);
    if (
      typeof params !== 'object' ||
      params === null ||
      !('algorithm' in params) ||
      !('memoryCost' in params) ||
      !('timeCost' in params) ||
      !('parallelism' in params) ||
      !('hashLength' in params) ||
      row.schema_version !== VAULT_VERSION ||
      row.kdf_algorithm !== ARGON2ID_PARAMS.algorithm ||
      params.algorithm !== ARGON2ID_PARAMS.algorithm ||
      params.memoryCost !== ARGON2ID_PARAMS.memoryCost ||
      params.timeCost !== ARGON2ID_PARAMS.timeCost ||
      params.parallelism !== ARGON2ID_PARAMS.parallelism ||
      params.hashLength !== ARGON2ID_PARAMS.hashLength
    ) {
      throw new Error('invalid kdf params');
    }

    return {
      version: VAULT_VERSION,
      kdf: {
        ...ARGON2ID_PARAMS,
        salt: row.kdf_salt
      },
      wrappedVaultKey: {
        version: VAULT_VERSION,
        nonce: row.wrapped_vault_key_nonce,
        ciphertext: row.wrapped_vault_key,
        authTag: row.wrapped_vault_key_tag,
        aad: row.wrapped_vault_key_aad
      }
    };
  } catch {
    throw new AppError('VAULT_CONFIG_INVALID');
  }
};

export class AppConfigRepository {
  constructor(private readonly database: SqliteDatabase) {}

  get(): AppConfigRow | null {
    const row = this.database.prepare(`
      SELECT schema_version, kdf_algorithm, kdf_params_json, kdf_salt,
             wrapped_vault_key, wrapped_vault_key_nonce, wrapped_vault_key_tag,
             wrapped_vault_key_aad, created_at, updated_at
      FROM app_config
      WHERE id = 1
    `).get() as AppConfigSqlRow | undefined;

    if (!row) {
      return null;
    }

    const vaultConfig = parseVaultConfig({ ...row, kdf_algorithm: row.kdf_algorithm });
    return {
      id: 1,
      schemaVersion: row.schema_version,
      vaultConfig,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  create(vaultConfig: VaultConfig): AppConfigRow {
    if (this.get()) {
      throw new AppError('SETUP_ALREADY_COMPLETE');
    }

    const timestamp = now();
    const kdfParams = {
      algorithm: vaultConfig.kdf.algorithm,
      memoryCost: vaultConfig.kdf.memoryCost,
      timeCost: vaultConfig.kdf.timeCost,
      parallelism: vaultConfig.kdf.parallelism,
      hashLength: vaultConfig.kdf.hashLength
    };

    this.database.prepare(`
      INSERT INTO app_config (
        id, schema_version, kdf_algorithm, kdf_params_json, kdf_salt,
        wrapped_vault_key, wrapped_vault_key_nonce, wrapped_vault_key_tag,
        wrapped_vault_key_aad, created_at, updated_at
      ) VALUES (1, @schemaVersion, @algorithm, @params, @salt,
                @ciphertext, @nonce, @authTag, @aad, @createdAt, @updatedAt)
    `).run({
      schemaVersion: vaultConfig.version,
      algorithm: vaultConfig.kdf.algorithm,
      params: JSON.stringify(kdfParams),
      salt: vaultConfig.kdf.salt,
      ciphertext: vaultConfig.wrappedVaultKey.ciphertext,
      nonce: vaultConfig.wrappedVaultKey.nonce,
      authTag: vaultConfig.wrappedVaultKey.authTag,
      aad: vaultConfig.wrappedVaultKey.aad,
      createdAt: timestamp,
      updatedAt: timestamp
    });

    const created = this.get();
    if (!created) {
      throw new AppError('INTERNAL_ERROR');
    }

    return created;
  }
}

export class GroupRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly ownerId: string
  ) {
    assertOwner(ownerId);
  }

  create(input: GroupCreateInput): GroupRow {
    const id = input.id ?? randomUUID();
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    const timestamp = now();

    try {
      this.database.prepare(`
        INSERT INTO groups (id, owner_id, name, sort_order, created_at, updated_at)
        VALUES (@id, @ownerId, @name, @sortOrder, @createdAt, @updatedAt)
      `).run({
        id,
        ownerId: this.ownerId,
        name: input.name,
        sortOrder: input.sortOrder ?? 0,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new AppError('GROUP_ALREADY_EXISTS');
      }

      throw error;
    }

    const created = this.get(id);
    if (!created) {
      throw new AppError('INTERNAL_ERROR');
    }

    return created;
  }

  get(id: string): GroupRow | null {
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    const row = this.database.prepare(`
      SELECT id, owner_id, name, sort_order, created_at, updated_at
      FROM groups
      WHERE id = @id AND owner_id = @ownerId
    `).get({ id, ownerId: this.ownerId }) as GroupSqlRow | undefined;
    return row ? toGroupRow(row) : null;
  }

  list(): GroupRow[] {
    const rows = this.database.prepare(`
      SELECT id, owner_id, name, sort_order, created_at, updated_at
      FROM groups
      WHERE owner_id = @ownerId
      ORDER BY sort_order ASC, name COLLATE NOCASE ASC
    `).all({ ownerId: this.ownerId }) as GroupSqlRow[];
    return rows.map(toGroupRow);
  }

  update(id: string, patch: GroupPatch): GroupRow {
    const current = this.get(id);
    if (!current) {
      throw new AppError('GROUP_NOT_FOUND');
    }

    const nextName = patch.name ?? current.name;
    const nextSortOrder = patch.sortOrder ?? current.sortOrder;
    try {
      this.database.prepare(`
        UPDATE groups
        SET name = @name, sort_order = @sortOrder, updated_at = @updatedAt
        WHERE id = @id AND owner_id = @ownerId
      `).run({
        id,
        ownerId: this.ownerId,
        name: nextName,
        sortOrder: nextSortOrder,
        updatedAt: now()
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new AppError('GROUP_ALREADY_EXISTS');
      }

      throw error;
    }

    const updated = this.get(id);
    if (!updated) {
      throw new AppError('INTERNAL_ERROR');
    }

    return updated;
  }

  delete(id: string): void {
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    const deleteGroup = this.database.transaction(() => {
      this.database.prepare(`
        UPDATE hosts SET group_id = NULL, updated_at = @updatedAt
        WHERE group_id = @id AND owner_id = @ownerId
      `).run({ id, ownerId: this.ownerId, updatedAt: now() });

      const result = this.database.prepare(`
        DELETE FROM groups WHERE id = @id AND owner_id = @ownerId
      `).run({ id, ownerId: this.ownerId });
      if (result.changes === 0) {
        throw new AppError('GROUP_NOT_FOUND');
      }
    });

    deleteGroup();
  }
}

export class HostRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly ownerId: string
  ) {
    assertOwner(ownerId);
  }

  private assertGroupBelongsToOwner(groupId: string | null): void {
    if (groupId === null) {
      return;
    }

    assertIdentifier(groupId, 'HOST_VALIDATION_FAILED');
    const row = this.database.prepare(`
      SELECT id FROM groups WHERE id = @groupId AND owner_id = @ownerId
    `).get({ groupId, ownerId: this.ownerId });
    if (!row) {
      throw new AppError('GROUP_NOT_FOUND');
    }
  }

  private getRow(id: string): HostRow | null {
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    const row = this.database.prepare(`
      SELECT id, owner_id, name, address, port, username, auth_type,
             credential_ciphertext, credential_version, host_key_algorithm,
             host_key_fingerprint, group_id, tags_json, is_favorite,
             last_connected_at, created_at, updated_at
      FROM hosts
      WHERE id = @id AND owner_id = @ownerId
    `).get({ id, ownerId: this.ownerId }) as HostSqlRow | undefined;
    return row ? toHostRow(row) : null;
  }

  createHost(input: HostCreateRow): HostRow {
    const id = input.id ?? randomUUID();
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    assertOwner(input.ownerId);
    if (input.ownerId !== this.ownerId) {
      throw new AppError('HOST_VALIDATION_FAILED');
    }
    this.assertGroupBelongsToOwner(input.groupId);
    const timestamp = now();

    try {
      this.database.prepare(`
        INSERT INTO hosts (
          id, owner_id, name, address, port, username, auth_type,
          credential_ciphertext, credential_version, host_key_algorithm,
          host_key_fingerprint, group_id, tags_json, is_favorite,
          last_connected_at, created_at, updated_at
        ) VALUES (
          @id, @ownerId, @name, @address, @port, @username, @authType,
          @credentialCiphertext, @credentialVersion, @hostKeyAlgorithm,
          @hostKeyFingerprint, @groupId, @tags, @isFavorite,
          @lastConnectedAt, @createdAt, @updatedAt
        )
      `).run({
        id,
        ownerId: this.ownerId,
        name: input.name,
        address: input.address,
        port: input.port,
        username: input.username,
        authType: input.authType,
        credentialCiphertext: input.credentialCiphertext,
        credentialVersion: input.credentialVersion,
        hostKeyAlgorithm: input.hostKeyAlgorithm,
        hostKeyFingerprint: input.hostKeyFingerprint,
        groupId: input.groupId,
        tags: serializeTags(input.tags),
        isFavorite: input.isFavorite ? 1 : 0,
        lastConnectedAt: input.lastConnectedAt,
        createdAt: timestamp,
        updatedAt: timestamp
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new AppError('HOST_VALIDATION_FAILED');
      }

      throw error;
    }

    const created = this.getRow(id);
    if (!created) {
      throw new AppError('INTERNAL_ERROR');
    }

    return created;
  }

  updateHost(id: string, patch: HostPatch): HostRow {
    const current = this.getRow(id);
    if (!current) {
      throw new AppError('HOST_NOT_FOUND');
    }

    const next = {
      name: patch.name ?? current.name,
      address: patch.address ?? current.address,
      port: patch.port ?? current.port,
      username: patch.username ?? current.username,
      authType: patch.authType ?? current.authType,
      credentialCiphertext: patch.credentialCiphertext ?? current.credentialCiphertext,
      credentialVersion: patch.credentialVersion ?? current.credentialVersion,
      hostKeyAlgorithm: patch.hostKeyAlgorithm === undefined ? current.hostKeyAlgorithm : patch.hostKeyAlgorithm,
      hostKeyFingerprint: patch.hostKeyFingerprint === undefined ? current.hostKeyFingerprint : patch.hostKeyFingerprint,
      groupId: patch.groupId === undefined ? current.groupId : patch.groupId,
      tags: patch.tags ?? current.tags,
      isFavorite: patch.isFavorite ?? current.isFavorite,
      lastConnectedAt: patch.lastConnectedAt === undefined ? current.lastConnectedAt : patch.lastConnectedAt
    };
    this.assertGroupBelongsToOwner(next.groupId);

    this.database.prepare(`
      UPDATE hosts
      SET name = @name, address = @address, port = @port, username = @username,
          auth_type = @authType, credential_ciphertext = @credentialCiphertext,
          credential_version = @credentialVersion, host_key_algorithm = @hostKeyAlgorithm,
          host_key_fingerprint = @hostKeyFingerprint, group_id = @groupId,
          tags_json = @tags, is_favorite = @isFavorite,
          last_connected_at = @lastConnectedAt, updated_at = @updatedAt
      WHERE id = @id AND owner_id = @ownerId
    `).run({
      id,
      ownerId: this.ownerId,
      ...next,
      tags: serializeTags(next.tags),
      isFavorite: next.isFavorite ? 1 : 0,
      updatedAt: now()
    });

    const updated = this.getRow(id);
    if (!updated) {
      throw new AppError('INTERNAL_ERROR');
    }

    return updated;
  }

  listMetadata(filter: HostFilter = {}): HostMetadata[] {
    const clauses = ['owner_id = @ownerId'];
    const parameters: Record<string, string | number> = { ownerId: this.ownerId };

    if (filter.query !== undefined) {
      if (typeof filter.query !== 'string' || filter.query.length > 128) {
        throw new AppError('HOST_VALIDATION_FAILED');
      }

      if (filter.query.length > 0) {
        clauses.push(`(
          name LIKE @query ESCAPE '\\' COLLATE NOCASE OR
          address LIKE @query ESCAPE '\\' COLLATE NOCASE OR
          username LIKE @query ESCAPE '\\' COLLATE NOCASE OR
          tags_json LIKE @query ESCAPE '\\' COLLATE NOCASE
        )`);
        parameters.query = `%${escapeLike(filter.query)}%`;
      }
    }

    if (filter.groupId !== undefined) {
      if (filter.groupId === null) {
        clauses.push('group_id IS NULL');
      } else {
        assertIdentifier(filter.groupId, 'HOST_VALIDATION_FAILED');
        clauses.push('group_id = @groupId');
        parameters.groupId = filter.groupId;
      }
    }

    if (filter.favorite !== undefined) {
      if (typeof filter.favorite !== 'boolean') {
        throw new AppError('HOST_VALIDATION_FAILED');
      }
      clauses.push('is_favorite = @favorite');
      parameters.favorite = filter.favorite ? 1 : 0;
    }

    const rows = this.database.prepare(`
      SELECT id, owner_id, name, address, port, username, auth_type,
             host_key_algorithm, host_key_fingerprint, group_id, tags_json,
             is_favorite, last_connected_at, created_at, updated_at
      FROM hosts
      WHERE ${clauses.join(' AND ')}
      ORDER BY is_favorite DESC,
               CASE WHEN last_connected_at IS NULL THEN 1 ELSE 0 END ASC,
               last_connected_at DESC,
               name COLLATE NOCASE ASC
    `).all(parameters) as HostMetadataSqlRow[];
    return rows.map(toHostMetadata);
  }

  getForConnection(id: string): HostRow | null {
    return this.getRow(id);
  }

  markConnected(id: string, connectedAt = now()): void {
    const result = this.database.prepare(`
      UPDATE hosts
      SET last_connected_at = @connectedAt, updated_at = @updatedAt
      WHERE id = @id AND owner_id = @ownerId
    `).run({ id, ownerId: this.ownerId, connectedAt, updatedAt: now() });
    if (result.changes === 0) {
      throw new AppError('HOST_NOT_FOUND');
    }
  }

  setHostKey(id: string, algorithm: string, fingerprint: string): void {
    const result = this.database.prepare(`
      UPDATE hosts
      SET host_key_algorithm = @algorithm,
          host_key_fingerprint = @fingerprint,
          updated_at = @updatedAt
      WHERE id = @id AND owner_id = @ownerId
    `).run({ id, ownerId: this.ownerId, algorithm, fingerprint, updatedAt: now() });
    if (result.changes === 0) {
      throw new AppError('HOST_NOT_FOUND');
    }
  }

  deleteHost(id: string): void {
    const deleteHost = this.database.transaction(() => {
      const result = this.database.prepare(`
        DELETE FROM hosts WHERE id = @id AND owner_id = @ownerId
      `).run({ id, ownerId: this.ownerId });
      if (result.changes === 0) {
        throw new AppError('HOST_NOT_FOUND');
      }
    });

    deleteHost();
  }
}

export class AuditRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly ownerId: string
  ) {
    assertOwner(ownerId);
  }

  insert(input: AuditEventInput): AuditEventRow {
    const id = randomUUID();
    const createdAt = now();
    const hostId = input.hostId ?? null;
    if (hostId !== null) {
      assertIdentifier(hostId, 'HOST_VALIDATION_FAILED');
      const host = this.database.prepare(`
        SELECT id FROM hosts WHERE id = @hostId AND owner_id = @ownerId
      `).get({ hostId, ownerId: this.ownerId });
      if (!host) {
        throw new AppError('HOST_NOT_FOUND');
      }
    }

    this.database.prepare(`
      INSERT INTO audit_events (id, owner_id, event_type, host_id, request_id, remote_address, created_at)
      VALUES (@id, @ownerId, @eventType, @hostId, @requestId, @remoteAddress, @createdAt)
    `).run({
      id,
      ownerId: this.ownerId,
      eventType: input.eventType,
      hostId,
      requestId: input.requestId,
      remoteAddress: input.remoteAddress ?? null,
      createdAt
    });

    const row = this.database.prepare(`
      SELECT id, owner_id, event_type, host_id, request_id, remote_address, created_at
      FROM audit_events WHERE id = @id AND owner_id = @ownerId
    `).get({ id, ownerId: this.ownerId }) as AuditSqlRow | undefined;
    if (!row) {
      throw new AppError('INTERNAL_ERROR');
    }

    return toAuditRow(row);
  }

  listRecent(limit = 50): AuditEventRow[] {
    const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
    const rows = this.database.prepare(`
      SELECT id, owner_id, event_type, host_id, request_id, remote_address, created_at
      FROM audit_events
      WHERE owner_id = @ownerId
      ORDER BY created_at DESC
      LIMIT @limit
    `).all({ ownerId: this.ownerId, limit: boundedLimit }) as AuditSqlRow[];
    return rows.map(toAuditRow);
  }
}
