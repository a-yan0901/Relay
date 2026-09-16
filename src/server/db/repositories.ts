import { randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import {
  connectionProfileSettingsSchema,
  connectionProfileSettingsPatchSchema,
  defaultConnectionProfileSettings,
  type ConnectionProfileSettings,
  type HostMetadata
} from '../../shared/validation.js';
import type { ClientPlatform, ConnectionProfileOverrides } from '../../shared/core/models.js';
import { ARGON2ID_PARAMS, VAULT_VERSION, type VaultConfig } from '../vault/types.js';
import type { SqliteDatabase } from './database.js';
import {
  type AppConfigRow,
  type AccountCreateRow,
  type AccountDeviceCreateRow,
  type AccountDeviceRow,
  type AccountRow,
  type AuditEventInput,
  type AuditEventRow,
  type AuditListFilter,
  type AuditMetadata,
  type CommandRunRow,
  type CommandRunTargetRow,
  type GroupCreateInput,
  type GroupPatch,
  type GroupRow,
  type HostCreateRow,
  type HostFilter,
  type HostPatch,
  type HostRow,
  type IdentityCreateRow,
  type IdentityPatch,
  type IdentityRow,
  type SnippetRow,
  type TransferJobCreateRow,
  type TransferJobPatch,
  type TransferJobRow
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

interface AccountSqlRow {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

interface AccountDeviceSqlRow {
  id: string;
  account_id: string;
  label: string;
  platform: ClientPlatform;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface GroupSqlRow {
  id: string;
  owner_id: string;
  name: string;
  parent_id: string | null;
  sort_order: number;
  default_identity_id: string | null;
  connection_profile_json: string | null;
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
  credential_ciphertext: string | null;
  credential_version: number;
  credential_source: 'inline' | 'identity' | 'group';
  identity_id: string | null;
  host_key_algorithm: string | null;
  host_key_fingerprint: string | null;
  group_id: string | null;
  tags_json: string;
  jump_host_ids_json: string;
  connection_profile_json: string;
  connection_profile_overrides_json: string | null;
  is_favorite: number;
  last_connected_at: string | null;
  created_at: string;
  updated_at: string;
}

type HostMetadataSqlRow = Omit<HostSqlRow, 'credential_ciphertext' | 'credential_version'>;

interface IdentitySqlRow {
  id: string;
  owner_id: string;
  name: string;
  type: 'password' | 'private_key';
  username: string;
  key_fingerprint: string | null;
  credential_ciphertext: string;
  credential_version: number;
  created_at: string;
  updated_at: string;
}

interface AuditSqlRow {
  sequence: number;
  id: string;
  owner_id: string;
  event_type: string;
  host_id: string | null;
  request_id: string;
  remote_address: string | null;
  metadata_json: string;
  created_at: string;
}

interface SnippetSqlRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  tags_json: string;
  command_ciphertext: string;
  variables_json: string;
  created_at: string;
  updated_at: string;
}

interface CommandRunSqlRow {
  id: string;
  owner_id: string;
  command_ciphertext: string;
  host_ids_json: string;
  status: CommandRunRow['status'];
  persist_output: number;
  created_at: string;
  finished_at: string | null;
}

interface CommandRunTargetSqlRow {
  run_id: string;
  owner_id: string;
  host_id: string;
  status: CommandRunTargetRow['status'];
  exit_code: number | null;
  output_ciphertext: string | null;
  output_bytes: number;
  output_truncated: number;
  error_code: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface TransferJobSqlRow {
  id: string;
  owner_id: string;
  kind: TransferJobRow['kind'];
  host_id: string;
  source_path: string;
  target_path: string;
  status: TransferJobRow['status'];
  completed_bytes: number;
  total_bytes: number | null;
  error_code: string | null;
  checkpoint_offset: number;
  checkpoint_checksum: string | null;
  temporary_path: string | null;
  created_at: string;
  updated_at: string;
}

const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ACCOUNT_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const ACCOUNT_PLATFORMS = new Set<ClientPlatform>(['web', 'desktop', 'android']);

const assertIdentifier = (value: string, code: 'HOST_VALIDATION_FAILED' | 'INTERNAL_ERROR' = 'INTERNAL_ERROR'): void => {
  if (typeof value !== 'string' || !SAFE_IDENTIFIER.test(value)) {
    throw new AppError(code);
  }
};

const assertOwner = (ownerId: string): void => assertIdentifier(ownerId);

const assertAccountEmail = (email: string): void => {
  if (
    typeof email !== 'string' ||
    email.length === 0 ||
    email.length > 320 ||
    email !== email.trim() ||
    !ACCOUNT_EMAIL.test(email)
  ) {
    throw new AppError('ACCOUNT_EMAIL_INVALID');
  }
};

const assertAccountId = (accountId: string): void => assertIdentifier(accountId, 'INTERNAL_ERROR');
const assertDeviceId = (deviceId: string): void => assertIdentifier(deviceId, 'INTERNAL_ERROR');

const assertAccountPasswordHash = (passwordHash: string): void => {
  if (typeof passwordHash !== 'string' || passwordHash.length < 16 || passwordHash.length > 1024) {
    throw new AppError('INTERNAL_ERROR');
  }
};

const assertDevicePlatform = (platform: ClientPlatform): void => {
  if (!ACCOUNT_PLATFORMS.has(platform)) throw new AppError('INTERNAL_ERROR');
};

const assertDeviceLabel = (label: string): void => {
  if (typeof label !== 'string' || label.length === 0 || label.length > 128 || [...label].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character === '\u007f')) {
    throw new AppError('INTERNAL_ERROR');
  }
};

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

const parseStringArray = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((item): item is string => typeof item === 'string')) throw new Error('array expected');
    return parsed;
  } catch {
    throw new AppError('INTERNAL_ERROR');
  }
};

const AUDIT_METADATA_KEYS = new Set(['runId', 'transferId', 'accountId', 'deviceId', 'vaultId', 'action', 'resolution', 'reason', 'status', 'targetCount', 'successCount', 'failureCount', 'cancelledCount', 'interruptedCount', 'anomalyCount', 'truncatedCount', 'durationMs', 'revision']);

const AUDIT_STATUS_SQL = `CASE
  WHEN json_extract(metadata_json, '$.status') IN ('queued', 'running', 'succeeded', 'failed', 'cancelled', 'interrupted') THEN json_extract(metadata_json, '$.status')
  WHEN event_type LIKE '%_queued' THEN 'queued'
  WHEN event_type LIKE '%_started' OR event_type LIKE '%_running' THEN 'running'
  WHEN event_type LIKE '%_failed' THEN 'failed'
  WHEN event_type LIKE '%_cancelled' THEN 'cancelled'
  WHEN event_type LIKE '%_interrupted' THEN 'interrupted'
  WHEN event_type = 'command_run_summary' AND CAST(json_extract(metadata_json, '$.failureCount') AS INTEGER) > 0 THEN 'failed'
  WHEN event_type = 'command_run_summary' AND CAST(json_extract(metadata_json, '$.interruptedCount') AS INTEGER) > 0 THEN 'interrupted'
  WHEN event_type = 'command_run_summary' AND CAST(json_extract(metadata_json, '$.cancelledCount') AS INTEGER) > 0 THEN 'cancelled'
  ELSE 'succeeded'
END`;

const parseAuditMetadata = (value: string): AuditMetadata => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('object expected');
    const result: Record<string, string | number | boolean | null> = {};
    for (const [key, item] of Object.entries(parsed)) {
      if (!AUDIT_METADATA_KEYS.has(key) || (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean' && item !== null)) throw new Error('unsafe metadata');
      result[key] = item;
    }
    return result;
  } catch {
    throw new AppError('AUDIT_METADATA_INVALID');
  }
};

const serializeAuditMetadata = (value: Readonly<Record<string, unknown>> | undefined): string => {
  if (value === undefined) return '{}';
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!AUDIT_METADATA_KEYS.has(key) || (typeof item !== 'string' && typeof item !== 'number' && typeof item !== 'boolean' && item !== null)) throw new AppError('AUDIT_METADATA_INVALID');
    result[key] = item;
  }
  return JSON.stringify(result);
};

const serializeTags = (tags: string[]): string => {
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string')) {
    throw new AppError('HOST_VALIDATION_FAILED');
  }

  return JSON.stringify(tags);
};

const parseJumpHostIds = (value: string): string[] => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length > 4 || !parsed.every((id): id is string => SAFE_IDENTIFIER.test(id)) || new Set(parsed).size !== parsed.length) {
      throw new Error('jump hosts must be unique identifiers');
    }
    return parsed;
  } catch {
    throw new AppError('INTERNAL_ERROR');
  }
};

const parseConnectionProfile = (value: string | undefined): ConnectionProfileSettings => {
  if (value === undefined) return defaultConnectionProfileSettings();
  try {
    const parsed: unknown = JSON.parse(value);
    const result = connectionProfileSettingsSchema.safeParse(parsed);
    if (!result.success) throw new Error('invalid connection profile');
    return result.data;
  } catch {
    throw new AppError('HOST_VALIDATION_FAILED');
  }
};

const parseConnectionProfileOverrides = (value: string | null | undefined): ConnectionProfileOverrides | null => {
  if (value === null || value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const result = connectionProfileSettingsPatchSchema.safeParse(parsed);
    if (!result.success) throw new Error('invalid connection profile overrides');
    return result.data;
  } catch {
    throw new AppError('HOST_VALIDATION_FAILED');
  }
};

const serializeConnectionProfile = (value: ConnectionProfileSettings | undefined): string => {
  const parsed = connectionProfileSettingsSchema.safeParse(value ?? defaultConnectionProfileSettings());
  if (!parsed.success) throw new AppError('HOST_VALIDATION_FAILED');
  return JSON.stringify(parsed.data);
};

const serializeConnectionProfileOverrides = (value: ConnectionProfileOverrides | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  const parsed = connectionProfileSettingsPatchSchema.safeParse(value);
  if (!parsed.success) throw new AppError('HOST_VALIDATION_FAILED');
  return JSON.stringify(parsed.data);
};

const serializeJumpHostIds = (ids: string[] | undefined): string => {
  if (ids === undefined) return '[]';
  if (!Array.isArray(ids) || ids.length > 4 || ids.some((id) => !SAFE_IDENTIFIER.test(id)) || new Set(ids).size !== ids.length) {
    throw new AppError('HOST_VALIDATION_FAILED');
  }
  return JSON.stringify(ids);
};

const escapeLike = (value: string): string => value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');

const toGroupRow = (row: GroupSqlRow): GroupRow => ({
  id: row.id,
  ownerId: row.owner_id,
  name: row.name,
  parentId: row.parent_id,
  sortOrder: row.sort_order,
  defaultIdentityId: row.default_identity_id,
  connectionProfile: parseConnectionProfileOverrides(row.connection_profile_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toAccountRow = (row: AccountSqlRow): AccountRow => ({
  id: row.id,
  email: row.email,
  passwordHash: row.password_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toAccountDeviceRow = (row: AccountDeviceSqlRow): AccountDeviceRow => ({
  id: row.id,
  accountId: row.account_id,
  label: row.label,
  platform: row.platform,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  revokedAt: row.revoked_at
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
  ...(row.credential_source === 'identity' && row.identity_id ? {
    credentialSource: { type: 'identity' as const, identityId: row.identity_id },
    identityId: row.identity_id
  } : row.credential_source === 'group' ? {
    credentialSource: { type: 'group' as const }
  } : {
    credentialSource: { type: 'inline' as const, authType: row.auth_type }
  }),
  hostKeyAlgorithm: row.host_key_algorithm,
  hostKeyFingerprint: row.host_key_fingerprint,
  groupId: row.group_id,
  tags: parseTags(row.tags_json),
  jumpHostIds: parseJumpHostIds(row.jump_host_ids_json),
  connectionProfile: parseConnectionProfile(row.connection_profile_json),
  connectionProfileOverrides: parseConnectionProfileOverrides(row.connection_profile_overrides_json),
  isFavorite: row.is_favorite === 1,
  lastConnectedAt: row.last_connected_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toIdentityRow = (row: IdentitySqlRow): IdentityRow => ({
  ownerId: row.owner_id,
  id: row.id,
  name: row.name,
  type: row.type,
  username: row.username,
  keyFingerprint: row.key_fingerprint,
  credentialCiphertext: row.credential_ciphertext,
  credentialVersion: row.credential_version,
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
  jumpHostIds: parseJumpHostIds(row.jump_host_ids_json),
  connectionProfile: parseConnectionProfile(row.connection_profile_json),
  connectionProfileOverrides: parseConnectionProfileOverrides(row.connection_profile_overrides_json),
  isFavorite: row.is_favorite === 1,
  lastConnectedAt: row.last_connected_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  ...(row.credential_source === 'identity' && row.identity_id ? {
    credentialSource: { type: 'identity' as const, identityId: row.identity_id },
    identityId: row.identity_id
  } : row.credential_source === 'group' ? {
    credentialSource: { type: 'group' as const }
  } : {
    credentialSource: { type: 'inline' as const, authType: row.auth_type }
  })
});

const toAuditRow = (row: AuditSqlRow): AuditEventRow => ({
  id: row.id,
  ownerId: row.owner_id,
  eventType: row.event_type,
  hostId: row.host_id,
  requestId: row.request_id,
  remoteAddress: row.remote_address,
  metadata: parseAuditMetadata(row.metadata_json),
  createdAt: row.created_at
});

const toSnippetRow = (row: SnippetSqlRow): SnippetRow => ({
  ownerId: row.owner_id,
  id: row.id,
  name: row.name,
  description: row.description,
  tags: parseTags(row.tags_json),
  commandCiphertext: row.command_ciphertext,
  variables: parseStringArray(row.variables_json),
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const toCommandRunRow = (row: CommandRunSqlRow): CommandRunRow => ({
  ownerId: row.owner_id,
  id: row.id,
  commandCiphertext: row.command_ciphertext,
  hostIds: parseStringArray(row.host_ids_json),
  status: row.status,
  persistOutput: row.persist_output === 1,
  createdAt: row.created_at,
  finishedAt: row.finished_at
});

const toCommandRunTargetRow = (row: CommandRunTargetSqlRow): CommandRunTargetRow => ({
  ownerId: row.owner_id,
  runId: row.run_id,
  hostId: row.host_id,
  status: row.status,
  exitCode: row.exit_code,
  outputCiphertext: row.output_ciphertext,
  outputBytes: row.output_bytes,
  outputTruncated: row.output_truncated === 1,
  errorCode: row.error_code,
  startedAt: row.started_at,
  finishedAt: row.finished_at
});

const toTransferJobRow = (row: TransferJobSqlRow): TransferJobRow => ({
  ownerId: row.owner_id,
  id: row.id,
  kind: row.kind,
  hostId: row.host_id,
  sourcePath: row.source_path,
  targetPath: row.target_path,
  status: row.status,
  completedBytes: row.completed_bytes,
  totalBytes: row.total_bytes,
  ...(row.error_code === null ? {} : { errorCode: row.error_code }),
  checkpoint: {
    transferId: row.id,
    offset: row.checkpoint_offset,
    totalBytes: row.total_bytes,
    checksum: row.checkpoint_checksum
  },
  temporaryPath: row.temporary_path,
  createdAt: row.created_at,
  updatedAt: row.updated_at
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

export class AccountRepository {
  constructor(private readonly database: SqliteDatabase) {}

  getAccountByEmail(email: string): AccountRow | null {
    assertAccountEmail(email);
    const row = this.database.prepare(`
      SELECT id, email, password_hash, created_at, updated_at
      FROM accounts
      WHERE email = @email COLLATE NOCASE
    `).get({ email }) as AccountSqlRow | undefined;
    return row ? toAccountRow(row) : null;
  }

  getAccount(id: string): AccountRow | null {
    assertAccountId(id);
    const row = this.database.prepare(`
      SELECT id, email, password_hash, created_at, updated_at
      FROM accounts
      WHERE id = @id
    `).get({ id }) as AccountSqlRow | undefined;
    return row ? toAccountRow(row) : null;
  }

  createAccount(input: AccountCreateRow): AccountRow {
    assertAccountId(input.id);
    assertAccountEmail(input.email);
    assertAccountPasswordHash(input.passwordHash);
    const timestamp = now();
    try {
      this.database.prepare(`
        INSERT INTO accounts (id, email, password_hash, created_at, updated_at)
        VALUES (@id, @email, @passwordHash, @createdAt, @updatedAt)
      `).run({
        id: input.id,
        email: input.email,
        passwordHash: input.passwordHash,
        createdAt: input.createdAt ?? timestamp,
        updatedAt: input.updatedAt ?? timestamp
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed: accounts.email')) {
        throw new AppError('ACCOUNT_EXISTS');
      }
      throw error;
    }

    const created = this.getAccount(input.id);
    if (!created) throw new AppError('INTERNAL_ERROR');
    return created;
  }

  createAccountWithDevice(
    account: AccountCreateRow,
    device: AccountDeviceCreateRow
  ): { account: AccountRow; device: AccountDeviceRow } {
    const create = this.database.transaction(() => {
      const createdAccount = this.createAccount(account);
      const createdDevice = this.createDevice(device);
      return { account: createdAccount, device: createdDevice };
    });
    return create();
  }

  getDevice(accountId: string, deviceId: string): AccountDeviceRow | null {
    assertAccountId(accountId);
    assertDeviceId(deviceId);
    const row = this.database.prepare(`
      SELECT id, account_id, label, platform, created_at, last_seen_at, revoked_at
      FROM account_devices
      WHERE account_id = @accountId AND id = @deviceId
    `).get({ accountId, deviceId }) as AccountDeviceSqlRow | undefined;
    return row ? toAccountDeviceRow(row) : null;
  }

  createDevice(input: AccountDeviceCreateRow): AccountDeviceRow {
    assertAccountId(input.accountId);
    assertDeviceId(input.id);
    assertDeviceLabel(input.label);
    assertDevicePlatform(input.platform);
    const timestamp = input.createdAt ?? now();
    try {
      this.database.prepare(`
        INSERT INTO account_devices (id, account_id, label, platform, created_at, last_seen_at, revoked_at)
        VALUES (@id, @accountId, @label, @platform, @createdAt, NULL, NULL)
      `).run({
        id: input.id,
        accountId: input.accountId,
        label: input.label,
        platform: input.platform,
        createdAt: timestamp
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('FOREIGN KEY constraint failed')) {
        throw new AppError('ACCOUNT_AUTH_FAILED');
      }
      throw error;
    }

    const created = this.getDevice(input.accountId, input.id);
    if (!created) throw new AppError('INTERNAL_ERROR');
    return created;
  }

  listDevices(accountId: string): AccountDeviceRow[] {
    assertAccountId(accountId);
    const rows = this.database.prepare(`
      SELECT id, account_id, label, platform, created_at, last_seen_at, revoked_at
      FROM account_devices
      WHERE account_id = @accountId
      ORDER BY created_at ASC, id ASC
    `).all({ accountId }) as AccountDeviceSqlRow[];
    return rows.map(toAccountDeviceRow);
  }

  touchDevice(accountId: string, deviceId: string, lastSeenAt = now()): boolean {
    assertAccountId(accountId);
    assertDeviceId(deviceId);
    const result = this.database.prepare(`
      UPDATE account_devices
      SET last_seen_at = @lastSeenAt
      WHERE account_id = @accountId AND id = @deviceId AND revoked_at IS NULL
    `).run({ accountId, deviceId, lastSeenAt });
    return result.changes > 0;
  }

  revokeDevice(accountId: string, deviceId: string, revokedAt = now()): boolean {
    assertAccountId(accountId);
    assertDeviceId(deviceId);
    const result = this.database.prepare(`
      UPDATE account_devices
      SET revoked_at = COALESCE(revoked_at, @revokedAt)
      WHERE account_id = @accountId AND id = @deviceId
    `).run({ accountId, deviceId, revokedAt });
    return result.changes > 0;
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
    const parentId = input.parentId ?? null;
    this.assertParent(id, parentId);
    this.assertIdentity(input.defaultIdentityId ?? null);
    const timestamp = now();

    try {
      this.database.prepare(`
        INSERT INTO groups (
          id, owner_id, name, parent_id, sort_order, default_identity_id,
          connection_profile_json, created_at, updated_at
        ) VALUES (
          @id, @ownerId, @name, @parentId, @sortOrder, @defaultIdentityId,
          @connectionProfile, @createdAt, @updatedAt
        )
      `).run({
        id,
        ownerId: this.ownerId,
        name: input.name,
        parentId,
        sortOrder: input.sortOrder ?? 0,
        defaultIdentityId: input.defaultIdentityId ?? null,
        connectionProfile: serializeConnectionProfileOverrides(input.connectionProfile),
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
      SELECT id, owner_id, name, parent_id, sort_order, default_identity_id,
             connection_profile_json, created_at, updated_at
      FROM groups
      WHERE id = @id AND owner_id = @ownerId
    `).get({ id, ownerId: this.ownerId }) as GroupSqlRow | undefined;
    return row ? toGroupRow(row) : null;
  }

  list(): GroupRow[] {
    const rows = this.database.prepare(`
      SELECT id, owner_id, name, parent_id, sort_order, default_identity_id,
             connection_profile_json, created_at, updated_at
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
    const nextParentId = patch.parentId === undefined ? current.parentId : patch.parentId;
    const nextSortOrder = patch.sortOrder ?? current.sortOrder;
    const nextDefaultIdentityId = patch.defaultIdentityId === undefined ? current.defaultIdentityId : patch.defaultIdentityId;
    const nextConnectionProfile = patch.connectionProfile === undefined ? current.connectionProfile : patch.connectionProfile;
    this.assertParent(id, nextParentId);
    this.assertIdentity(nextDefaultIdentityId);
    try {
      this.database.prepare(`
        UPDATE groups
        SET name = @name, parent_id = @parentId, sort_order = @sortOrder,
            default_identity_id = @defaultIdentityId,
            connection_profile_json = @connectionProfile,
            updated_at = @updatedAt
        WHERE id = @id AND owner_id = @ownerId
      `).run({
        id,
        ownerId: this.ownerId,
        name: nextName,
        parentId: nextParentId,
        sortOrder: nextSortOrder,
        defaultIdentityId: nextDefaultIdentityId,
        connectionProfile: serializeConnectionProfileOverrides(nextConnectionProfile),
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
    const current = this.get(id);
    if (!current) throw new AppError('GROUP_NOT_FOUND');
    const deleteGroup = this.database.transaction(() => {
      const inUse = this.database.prepare(`
        SELECT 1 AS present
        FROM hosts
        WHERE owner_id = @ownerId AND group_id = @id AND credential_source = 'group'
        LIMIT 1
      `).get({ id, ownerId: this.ownerId });
      if (inUse) throw new AppError('GROUP_IN_USE');

      this.database.prepare(`
        UPDATE hosts SET group_id = NULL, updated_at = @updatedAt
        WHERE group_id = @id AND owner_id = @ownerId
      `).run({ id, ownerId: this.ownerId, updatedAt: now() });

      this.database.prepare(`
        UPDATE groups SET parent_id = @parentId, updated_at = @updatedAt
        WHERE parent_id = @id AND owner_id = @ownerId
      `).run({ id, parentId: current.parentId, ownerId: this.ownerId, updatedAt: now() });

      const result = this.database.prepare(`
        DELETE FROM groups WHERE id = @id AND owner_id = @ownerId
      `).run({ id, ownerId: this.ownerId });
      if (result.changes === 0) {
        throw new AppError('GROUP_NOT_FOUND');
      }
    });

    deleteGroup();
  }

  private assertIdentity(identityId: string | null): void {
    if (identityId === null) return;
    assertIdentifier(identityId, 'HOST_VALIDATION_FAILED');
    const row = this.database.prepare('SELECT id FROM identities WHERE id = @identityId AND owner_id = @ownerId').get({ identityId, ownerId: this.ownerId });
    if (!row) throw new AppError('IDENTITY_NOT_FOUND');
  }

  private assertParent(groupId: string, parentId: string | null): void {
    if (parentId === null) return;
    assertIdentifier(parentId, 'HOST_VALIDATION_FAILED');
    const active = new Set([groupId]);
    let cursor: string | null = parentId;
    let depth = 1;
    while (cursor !== null) {
      if (active.has(cursor)) throw new AppError('GROUP_CYCLE');
      const parent = this.get(cursor);
      if (!parent) throw new AppError('GROUP_NOT_FOUND');
      active.add(cursor);
      depth += 1;
      if (depth > 8) throw new AppError('GROUP_DEPTH_EXCEEDED');
      cursor = parent.parentId;
    }
  }
}

export class IdentityRepository {
  constructor(
    private readonly database: SqliteDatabase,
    readonly ownerId: string
  ) {
    assertOwner(ownerId);
  }

  create(input: IdentityCreateRow): IdentityRow {
    assertIdentifier(input.id, 'HOST_VALIDATION_FAILED');
    if (input.ownerId !== this.ownerId) throw new AppError('HOST_VALIDATION_FAILED');
    try {
      this.database.prepare(`
        INSERT INTO identities (
          id, owner_id, name, type, username, key_fingerprint,
          credential_ciphertext, credential_version, created_at, updated_at
        ) VALUES (@id, @ownerId, @name, @type, @username, @keyFingerprint,
                  @credentialCiphertext, @credentialVersion, @createdAt, @updatedAt)
      `).run(input);
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new AppError('GROUP_ALREADY_EXISTS', '已存在同名凭据身份');
      }
      throw error;
    }
    const created = this.get(input.id);
    if (!created) throw new AppError('INTERNAL_ERROR');
    return created;
  }

  get(id: string): IdentityRow | null {
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    const row = this.database.prepare(`
      SELECT id, owner_id, name, type, username, key_fingerprint,
             credential_ciphertext, credential_version, created_at, updated_at
      FROM identities WHERE id = @id AND owner_id = @ownerId
    `).get({ id, ownerId: this.ownerId }) as IdentitySqlRow | undefined;
    return row ? toIdentityRow(row) : null;
  }

  list(): IdentityRow[] {
    const rows = this.database.prepare(`
      SELECT id, owner_id, name, type, username, key_fingerprint,
             credential_ciphertext, credential_version, created_at, updated_at
      FROM identities WHERE owner_id = @ownerId ORDER BY name COLLATE NOCASE ASC
    `).all({ ownerId: this.ownerId }) as IdentitySqlRow[];
    return rows.map(toIdentityRow);
  }

  countHostReferences(id: string): number {
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    const hostRow = this.database.prepare('SELECT COUNT(*) AS count FROM hosts WHERE owner_id = @ownerId AND credential_source = \'identity\' AND identity_id = @id').get({ ownerId: this.ownerId, id }) as { count: number };
    const groupRow = this.database.prepare('SELECT COUNT(*) AS count FROM groups WHERE owner_id = @ownerId AND default_identity_id = @id').get({ ownerId: this.ownerId, id }) as { count: number };
    return hostRow.count + groupRow.count;
  }

  update(id: string, patch: IdentityPatch): IdentityRow {
    const current = this.get(id);
    if (!current) throw new AppError('IDENTITY_NOT_FOUND');
    try {
      this.database.prepare(`
        UPDATE identities
        SET name = @name, type = @type, username = @username,
            key_fingerprint = @keyFingerprint, credential_ciphertext = @credentialCiphertext,
            credential_version = @credentialVersion, updated_at = @updatedAt
        WHERE id = @id AND owner_id = @ownerId
      `).run({
        id,
        ownerId: this.ownerId,
        name: patch.name ?? current.name,
        type: patch.type ?? current.type,
        username: patch.username ?? current.username,
        keyFingerprint: patch.keyFingerprint === undefined ? current.keyFingerprint : patch.keyFingerprint,
        credentialCiphertext: patch.credentialCiphertext ?? current.credentialCiphertext,
        credentialVersion: patch.credentialVersion ?? current.credentialVersion,
        updatedAt: patch.updatedAt ?? now()
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
        throw new AppError('GROUP_ALREADY_EXISTS', '已存在同名凭据身份');
      }
      throw error;
    }
    const updated = this.get(id);
    if (!updated) throw new AppError('INTERNAL_ERROR');
    return updated;
  }

  delete(id: string): void {
    const current = this.get(id);
    if (!current) throw new AppError('IDENTITY_NOT_FOUND');
    if (this.countHostReferences(id) > 0) throw new AppError('IDENTITY_IN_USE');
    const result = this.database.prepare('DELETE FROM identities WHERE id = @id AND owner_id = @ownerId').run({ id, ownerId: this.ownerId });
    if (result.changes === 0) throw new AppError('IDENTITY_NOT_FOUND');
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

  private assertIdentityBelongsToOwner(identityId: string | null): void {
    if (identityId === null) return;
    assertIdentifier(identityId, 'HOST_VALIDATION_FAILED');
    const row = this.database.prepare('SELECT id FROM identities WHERE id = @identityId AND owner_id = @ownerId').get({ identityId, ownerId: this.ownerId });
    if (!row) throw new AppError('IDENTITY_NOT_FOUND');
  }

  private getRow(id: string): HostRow | null {
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    const row = this.database.prepare(`
      SELECT id, owner_id, name, address, port, username, auth_type,
             credential_ciphertext, credential_version, credential_source, identity_id, host_key_algorithm,
             host_key_fingerprint, group_id, tags_json, is_favorite,
             jump_host_ids_json,
             connection_profile_json, connection_profile_overrides_json,
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
    const credentialSource = input.credentialSource ?? 'inline';
    const identityId = input.identityId ?? null;
    this.assertIdentityBelongsToOwner(identityId);
    if (
      (credentialSource === 'identity' && (identityId === null || input.credentialCiphertext !== null)) ||
      (credentialSource === 'inline' && (input.credentialCiphertext === null || identityId !== null)) ||
      (credentialSource === 'group' && (input.groupId === null || input.credentialCiphertext !== null || identityId !== null))
    ) {
      throw new AppError('HOST_VALIDATION_FAILED');
    }
    const timestamp = now();

    try {
      this.database.prepare(`
        INSERT INTO hosts (
          id, owner_id, name, address, port, username, auth_type,
          credential_ciphertext, credential_version, credential_source, identity_id, host_key_algorithm,
          host_key_fingerprint, group_id, tags_json, is_favorite,
          jump_host_ids_json,
          connection_profile_json, connection_profile_overrides_json,
          last_connected_at, created_at, updated_at
        ) VALUES (
          @id, @ownerId, @name, @address, @port, @username, @authType,
          @credentialCiphertext, @credentialVersion, @credentialSource, @identityId, @hostKeyAlgorithm,
          @hostKeyFingerprint, @groupId, @tags, @isFavorite,
          @jumpHostIds,
          @connectionProfile, @connectionProfileOverrides,
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
        credentialSource,
        identityId,
        hostKeyAlgorithm: input.hostKeyAlgorithm,
        hostKeyFingerprint: input.hostKeyFingerprint,
        groupId: input.groupId,
        tags: serializeTags(input.tags),
        jumpHostIds: serializeJumpHostIds(input.jumpHostIds),
        connectionProfile: serializeConnectionProfile(input.connectionProfile),
        connectionProfileOverrides: serializeConnectionProfileOverrides(input.connectionProfileOverrides),
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
      credentialCiphertext: patch.credentialCiphertext === undefined ? current.credentialCiphertext : patch.credentialCiphertext,
      credentialVersion: patch.credentialVersion ?? current.credentialVersion,
      credentialSource: patch.credentialSource ?? current.credentialSource?.type ?? 'inline',
      identityId: patch.identityId === undefined ? current.identityId ?? null : patch.identityId,
      hostKeyAlgorithm: patch.hostKeyAlgorithm === undefined ? current.hostKeyAlgorithm : patch.hostKeyAlgorithm,
      hostKeyFingerprint: patch.hostKeyFingerprint === undefined ? current.hostKeyFingerprint : patch.hostKeyFingerprint,
      groupId: patch.groupId === undefined ? current.groupId : patch.groupId,
      tags: patch.tags ?? current.tags,
      jumpHostIds: patch.jumpHostIds === undefined ? current.jumpHostIds : patch.jumpHostIds,
      connectionProfile: patch.connectionProfile === undefined ? current.connectionProfile : patch.connectionProfile,
      connectionProfileOverrides: patch.connectionProfileOverrides === undefined ? current.connectionProfileOverrides : patch.connectionProfileOverrides,
      isFavorite: patch.isFavorite ?? current.isFavorite,
      lastConnectedAt: patch.lastConnectedAt === undefined ? current.lastConnectedAt : patch.lastConnectedAt
    };
    this.assertGroupBelongsToOwner(next.groupId);
    this.assertIdentityBelongsToOwner(next.credentialSource === 'identity' ? next.identityId : null);
    if (
      (next.credentialSource === 'identity' && (next.identityId === null || next.credentialCiphertext !== null)) ||
      (next.credentialSource === 'inline' && (next.credentialCiphertext === null || next.identityId !== null)) ||
      (next.credentialSource === 'group' && (next.groupId === null || next.credentialCiphertext !== null || next.identityId !== null))
    ) {
      throw new AppError('HOST_VALIDATION_FAILED');
    }

    this.database.prepare(`
      UPDATE hosts
      SET name = @name, address = @address, port = @port, username = @username,
          auth_type = @authType, credential_ciphertext = @credentialCiphertext,
          credential_version = @credentialVersion, credential_source = @credentialSource,
          identity_id = @identityId, host_key_algorithm = @hostKeyAlgorithm,
          host_key_fingerprint = @hostKeyFingerprint, group_id = @groupId,
          tags_json = @tags, jump_host_ids_json = @jumpHostIds,
          connection_profile_json = @connectionProfile,
          connection_profile_overrides_json = @connectionProfileOverrides,
          is_favorite = @isFavorite,
          last_connected_at = @lastConnectedAt, updated_at = @updatedAt
      WHERE id = @id AND owner_id = @ownerId
    `).run({
      id,
      ownerId: this.ownerId,
      ...next,
      tags: serializeTags(next.tags),
      jumpHostIds: serializeJumpHostIds(next.jumpHostIds),
      connectionProfile: serializeConnectionProfile(next.connectionProfile),
      connectionProfileOverrides: serializeConnectionProfileOverrides(next.connectionProfileOverrides),
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
             credential_source, identity_id,
             jump_host_ids_json, connection_profile_json, connection_profile_overrides_json, is_favorite,
             last_connected_at, created_at, updated_at
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

  listForBundle(): HostRow[] {
    const rows = this.database.prepare(`
      SELECT id, owner_id, name, address, port, username, auth_type,
             credential_ciphertext, credential_version, credential_source, identity_id, host_key_algorithm,
             host_key_fingerprint, group_id, tags_json, is_favorite,
             jump_host_ids_json, connection_profile_json, connection_profile_overrides_json,
             last_connected_at, created_at, updated_at
      FROM hosts
      WHERE owner_id = @ownerId
      ORDER BY id ASC
    `).all({ ownerId: this.ownerId }) as HostSqlRow[];
    return rows.map(toHostRow);
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

  clearHostKey(id: string): void {
    const result = this.database.prepare(`
      UPDATE hosts
      SET host_key_algorithm = NULL,
          host_key_fingerprint = NULL,
          updated_at = @updatedAt
      WHERE id = @id AND owner_id = @ownerId
    `).run({ id, ownerId: this.ownerId, updatedAt: now() });
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
      INSERT INTO audit_events (id, owner_id, event_type, host_id, request_id, remote_address, metadata_json, created_at)
      VALUES (@id, @ownerId, @eventType, @hostId, @requestId, @remoteAddress, @metadata, @createdAt)
    `).run({
      id,
      ownerId: this.ownerId,
      eventType: input.eventType,
      hostId,
      requestId: input.requestId,
      remoteAddress: input.remoteAddress ?? null,
      metadata: serializeAuditMetadata(input.metadata),
      createdAt
    });

    const row = this.database.prepare(`
      SELECT rowid AS sequence, id, owner_id, event_type, host_id, request_id, remote_address, metadata_json, created_at
      FROM audit_events WHERE id = @id AND owner_id = @ownerId
    `).get({ id, ownerId: this.ownerId }) as AuditSqlRow | undefined;
    if (!row) {
      throw new AppError('INTERNAL_ERROR');
    }

    return toAuditRow(row);
  }

  listRecent(limit = 50): AuditEventRow[] {
    const boundedLimit = Number.isInteger(limit) ? Math.min(Math.max(limit, 1), 100) : 50;
    return this.list({ limit: boundedLimit }).items;
  }

  list(filter: AuditListFilter = {}): { items: AuditEventRow[]; hasMore: boolean; nextCursor?: AuditListFilter['cursor'] } {
    const boundedLimit = Number.isInteger(filter.limit) ? Math.min(Math.max(filter.limit as number, 1), 100) : 50;
    const clauses = ['owner_id = @ownerId'];
    const parameters: Record<string, string | number> = { ownerId: this.ownerId, limit: boundedLimit + 1 };
    if (filter.eventType !== undefined) {
      clauses.push('event_type = @eventType');
      parameters.eventType = filter.eventType;
    }
    if (filter.hostId !== undefined) {
      clauses.push('host_id = @hostId');
      parameters.hostId = filter.hostId;
    }
    if (filter.requestId !== undefined) {
      clauses.push('request_id = @requestId');
      parameters.requestId = filter.requestId;
    }
    if (filter.status !== undefined) {
      clauses.push(`(${AUDIT_STATUS_SQL}) = @status`);
      parameters.status = filter.status;
    }
    if (filter.from !== undefined) {
      clauses.push('created_at >= @from');
      parameters.from = filter.from;
    }
    if (filter.to !== undefined) {
      clauses.push('created_at <= @to');
      parameters.to = filter.to;
    }
    if (filter.cursor !== undefined) {
      if (filter.cursor.sequence === undefined) {
        clauses.push('(created_at < @cursorCreatedAt OR (created_at = @cursorCreatedAt AND id < @cursorId))');
      } else {
        clauses.push('(created_at < @cursorCreatedAt OR (created_at = @cursorCreatedAt AND rowid < @cursorSequence))');
        parameters.cursorSequence = filter.cursor.sequence;
      }
      parameters.cursorCreatedAt = filter.cursor.createdAt;
      parameters.cursorId = filter.cursor.id;
    }
    const rows = this.database.prepare(`
      SELECT rowid AS sequence, id, owner_id, event_type, host_id, request_id, remote_address, metadata_json, created_at
      FROM audit_events
      WHERE ${clauses.join(' AND ')}
      ORDER BY created_at DESC, rowid DESC
      LIMIT @limit
    `).all(parameters) as AuditSqlRow[];
    const hasMore = rows.length > boundedLimit;
    const page = rows.slice(0, boundedLimit);
    const last = page.at(-1);
    return {
      items: page.map(toAuditRow),
      hasMore,
      ...(hasMore && last ? { nextCursor: { createdAt: last.created_at, id: last.id, sequence: last.sequence } } : {})
    };
  }
}

export type SnippetPatchRow = Partial<Pick<SnippetRow, 'name' | 'description' | 'tags' | 'commandCiphertext' | 'variables' | 'updatedAt'>>;

export class SnippetRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly ownerId: string
  ) {
    assertOwner(ownerId);
  }

  create(input: SnippetRow): SnippetRow {
    assertIdentifier(input.id, 'HOST_VALIDATION_FAILED');
    if (input.ownerId !== this.ownerId) throw new AppError('HOST_VALIDATION_FAILED');
    try {
      this.database.prepare(`
        INSERT INTO snippets (id, owner_id, name, description, tags_json, command_ciphertext, variables_json, created_at, updated_at)
        VALUES (@id, @ownerId, @name, @description, @tags, @commandCiphertext, @variables, @createdAt, @updatedAt)
      `).run({
        id: input.id,
        ownerId: this.ownerId,
        name: input.name,
        description: input.description,
        tags: serializeTags(input.tags),
        commandCiphertext: input.commandCiphertext,
        variables: JSON.stringify(input.variables),
        createdAt: input.createdAt,
        updatedAt: input.updatedAt
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) throw new AppError('COMMAND_RUN_VALIDATION_FAILED');
      throw error;
    }
    const created = this.get(input.id);
    if (!created) throw new AppError('INTERNAL_ERROR');
    return created;
  }

  get(id: string): SnippetRow | null {
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    const row = this.database.prepare(`
      SELECT id, owner_id, name, description, tags_json, command_ciphertext, variables_json, created_at, updated_at
      FROM snippets WHERE id = @id AND owner_id = @ownerId
    `).get({ id, ownerId: this.ownerId }) as SnippetSqlRow | undefined;
    return row ? toSnippetRow(row) : null;
  }

  list(): SnippetRow[] {
    const rows = this.database.prepare(`
      SELECT id, owner_id, name, description, tags_json, command_ciphertext, variables_json, created_at, updated_at
      FROM snippets WHERE owner_id = @ownerId ORDER BY name COLLATE NOCASE ASC
    `).all({ ownerId: this.ownerId }) as SnippetSqlRow[];
    return rows.map(toSnippetRow);
  }

  update(id: string, patch: SnippetPatchRow): SnippetRow {
    const current = this.get(id);
    if (!current) throw new AppError('SNIPPET_NOT_FOUND');
    this.database.prepare(`
      UPDATE snippets
      SET name = @name, description = @description, tags_json = @tags,
          command_ciphertext = @commandCiphertext, variables_json = @variables, updated_at = @updatedAt
      WHERE id = @id AND owner_id = @ownerId
    `).run({
      id,
      ownerId: this.ownerId,
      name: patch.name ?? current.name,
      description: patch.description === undefined ? current.description : patch.description,
      tags: serializeTags(patch.tags ?? current.tags),
      commandCiphertext: patch.commandCiphertext ?? current.commandCiphertext,
      variables: JSON.stringify(patch.variables ?? current.variables),
      updatedAt: patch.updatedAt ?? now()
    });
    const updated = this.get(id);
    if (!updated) throw new AppError('INTERNAL_ERROR');
    return updated;
  }

  delete(id: string): void {
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    const result = this.database.prepare('DELETE FROM snippets WHERE id = @id AND owner_id = @ownerId').run({ id, ownerId: this.ownerId });
    if (result.changes === 0) throw new AppError('SNIPPET_NOT_FOUND');
  }
}

export type CommandRunPatchRow = Partial<Pick<CommandRunRow, 'commandCiphertext' | 'hostIds' | 'status' | 'persistOutput' | 'finishedAt'>>;
export type CommandRunTargetPatchRow = Partial<Pick<CommandRunTargetRow, 'status' | 'exitCode' | 'outputCiphertext' | 'outputBytes' | 'outputTruncated' | 'errorCode' | 'startedAt' | 'finishedAt'>>;

export class CommandRunRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly ownerId: string
  ) {
    assertOwner(ownerId);
  }

  createRun(input: CommandRunRow): void {
    assertIdentifier(input.id, 'HOST_VALIDATION_FAILED');
    if (input.ownerId !== this.ownerId) throw new AppError('HOST_VALIDATION_FAILED');
    this.database.prepare(`
      INSERT INTO command_runs (id, owner_id, command_ciphertext, host_ids_json, status, persist_output, created_at, finished_at)
      VALUES (@id, @ownerId, @commandCiphertext, @hostIds, @status, @persistOutput, @createdAt, @finishedAt)
    `).run({
      id: input.id,
      ownerId: this.ownerId,
      commandCiphertext: input.commandCiphertext,
      hostIds: JSON.stringify(input.hostIds),
      status: input.status,
      persistOutput: input.persistOutput ? 1 : 0,
      createdAt: input.createdAt,
      finishedAt: input.finishedAt
    });
  }

  createTarget(input: CommandRunTargetRow): void {
    assertIdentifier(input.runId, 'HOST_VALIDATION_FAILED');
    assertIdentifier(input.hostId, 'HOST_VALIDATION_FAILED');
    if (input.ownerId !== this.ownerId) throw new AppError('HOST_VALIDATION_FAILED');
    this.database.prepare(`
      INSERT INTO command_run_targets (
        run_id, owner_id, host_id, status, exit_code, output_ciphertext, output_bytes,
        output_truncated, error_code, started_at, finished_at
      ) VALUES (@runId, @ownerId, @hostId, @status, @exitCode, @outputCiphertext, @outputBytes,
                @outputTruncated, @errorCode, @startedAt, @finishedAt)
    `).run({
      runId: input.runId,
      ownerId: this.ownerId,
      hostId: input.hostId,
      status: input.status,
      exitCode: input.exitCode,
      outputCiphertext: input.outputCiphertext,
      outputBytes: input.outputBytes,
      outputTruncated: input.outputTruncated ? 1 : 0,
      errorCode: input.errorCode,
      startedAt: input.startedAt,
      finishedAt: input.finishedAt
    });
  }

  getRun(id: string): CommandRunRow | null {
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    const row = this.database.prepare(`
      SELECT id, owner_id, command_ciphertext, host_ids_json, status, persist_output, created_at, finished_at
      FROM command_runs WHERE id = @id AND owner_id = @ownerId
    `).get({ id, ownerId: this.ownerId }) as CommandRunSqlRow | undefined;
    return row ? toCommandRunRow(row) : null;
  }

  listTargets(runId: string): CommandRunTargetRow[] {
    assertIdentifier(runId, 'HOST_VALIDATION_FAILED');
    const rows = this.database.prepare(`
      SELECT run_id, owner_id, host_id, status, exit_code, output_ciphertext, output_bytes,
             output_truncated, error_code, started_at, finished_at
      FROM command_run_targets WHERE run_id = @runId AND owner_id = @ownerId ORDER BY rowid ASC
    `).all({ runId, ownerId: this.ownerId }) as CommandRunTargetSqlRow[];
    return rows.map(toCommandRunTargetRow);
  }

  updateRun(id: string, patch: CommandRunPatchRow): void {
    const current = this.getRun(id);
    if (!current) throw new AppError('COMMAND_RUN_NOT_FOUND');
    this.database.prepare(`
      UPDATE command_runs SET command_ciphertext = @commandCiphertext, host_ids_json = @hostIds,
        status = @status, persist_output = @persistOutput, finished_at = @finishedAt
      WHERE id = @id AND owner_id = @ownerId
    `).run({
      id,
      ownerId: this.ownerId,
      commandCiphertext: patch.commandCiphertext ?? current.commandCiphertext,
      hostIds: JSON.stringify(patch.hostIds ?? current.hostIds),
      status: patch.status ?? current.status,
      persistOutput: (patch.persistOutput ?? current.persistOutput) ? 1 : 0,
      finishedAt: patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt
    });
  }

  updateTarget(runId: string, hostId: string, patch: CommandRunTargetPatchRow): void {
    const current = this.listTargets(runId).find((target) => target.hostId === hostId);
    if (!current) throw new AppError('COMMAND_RUN_NOT_FOUND');
    this.database.prepare(`
      UPDATE command_run_targets SET status = @status, exit_code = @exitCode,
        output_ciphertext = @outputCiphertext, output_bytes = @outputBytes,
        output_truncated = @outputTruncated, error_code = @errorCode,
        started_at = @startedAt, finished_at = @finishedAt
      WHERE run_id = @runId AND host_id = @hostId AND owner_id = @ownerId
    `).run({
      runId,
      hostId,
      ownerId: this.ownerId,
      status: patch.status ?? current.status,
      exitCode: patch.exitCode === undefined ? current.exitCode : patch.exitCode,
      outputCiphertext: patch.outputCiphertext === undefined ? current.outputCiphertext : patch.outputCiphertext,
      outputBytes: patch.outputBytes ?? current.outputBytes,
      outputTruncated: (patch.outputTruncated ?? current.outputTruncated) ? 1 : 0,
      errorCode: patch.errorCode === undefined ? current.errorCode : patch.errorCode,
      startedAt: patch.startedAt === undefined ? current.startedAt : patch.startedAt,
      finishedAt: patch.finishedAt === undefined ? current.finishedAt : patch.finishedAt
    });
  }

  deleteRun(id: string): void {
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    this.database.prepare('DELETE FROM command_runs WHERE id = @id AND owner_id = @ownerId').run({
      id,
      ownerId: this.ownerId
    });
  }

  deleteExpiredFinishedRuns(cutoff: string): void {
    this.database.prepare(`
      DELETE FROM command_runs
      WHERE owner_id = @ownerId
        AND status IN ('completed', 'failed', 'cancelled', 'interrupted')
        AND COALESCE(finished_at, created_at) <= @cutoff
    `).run({ ownerId: this.ownerId, cutoff });
  }

  deleteStaleRuns(cutoff: string): void {
    this.database.prepare(`
      DELETE FROM command_runs
      WHERE owner_id = @ownerId AND created_at <= @cutoff
    `).run({ ownerId: this.ownerId, cutoff });
  }

  markActiveRunsInterrupted(errorCode: string, finishedAt: string): number {
    const operation = this.database.transaction(() => {
      const result = this.database.prepare(`
        UPDATE command_runs
        SET status = 'interrupted', finished_at = @finishedAt
        WHERE owner_id = @ownerId AND status IN ('queued', 'running')
      `).run({ ownerId: this.ownerId, errorCode, finishedAt });
      this.database.prepare(`
        UPDATE command_run_targets
        SET status = 'interrupted', error_code = @errorCode, finished_at = @finishedAt
        WHERE owner_id = @ownerId AND status IN ('queued', 'running')
      `).run({ ownerId: this.ownerId, errorCode, finishedAt });
      return result.changes;
    });
    return operation();
  }

  /** @deprecated Use markActiveRunsInterrupted; retained for repository clients compiled against v0.1.0. */
  markActiveRunsFailed(errorCode: string, finishedAt: string): number {
    return this.markActiveRunsInterrupted(errorCode, finishedAt);
  }
}

export class TransferRepository {
  constructor(
    private readonly database: SqliteDatabase,
    private readonly ownerId: string
  ) {
    assertOwner(ownerId);
  }

  create(input: TransferJobCreateRow): TransferJobRow {
    assertIdentifier(input.id, 'HOST_VALIDATION_FAILED');
    if (input.ownerId !== this.ownerId) throw new AppError('HOST_VALIDATION_FAILED');
    this.database.prepare(`
      INSERT INTO transfer_jobs (id, owner_id, kind, host_id, source_path, target_path, status, completed_bytes, total_bytes, error_code, checkpoint_offset, checkpoint_checksum, temporary_path, created_at, updated_at)
      VALUES (@id, @ownerId, @kind, @hostId, @sourcePath, @targetPath, @status, @completedBytes, @totalBytes, @errorCode, @checkpointOffset, @checkpointChecksum, @temporaryPath, @createdAt, @updatedAt)
    `).run({
      id: input.id,
      ownerId: this.ownerId,
      kind: input.kind,
      hostId: input.hostId,
      sourcePath: input.sourcePath,
      targetPath: input.targetPath,
      status: input.status,
      completedBytes: input.completedBytes,
      totalBytes: input.totalBytes,
      errorCode: input.errorCode ?? null,
      checkpointOffset: input.checkpointOffset ?? input.completedBytes,
      checkpointChecksum: input.checkpointChecksum ?? null,
      temporaryPath: input.temporaryPath ?? null,
      createdAt: input.createdAt,
      updatedAt: input.updatedAt
    });
    const created = this.get(input.id);
    if (!created) throw new AppError('INTERNAL_ERROR');
    return created;
  }

  get(id: string): TransferJobRow | null {
    assertIdentifier(id, 'HOST_VALIDATION_FAILED');
    const row = this.database.prepare(`
      SELECT id, owner_id, kind, host_id, source_path, target_path, status, completed_bytes, total_bytes, error_code, checkpoint_offset, checkpoint_checksum, temporary_path, created_at, updated_at
      FROM transfer_jobs WHERE id = @id AND owner_id = @ownerId
    `).get({ id, ownerId: this.ownerId }) as TransferJobSqlRow | undefined;
    return row ? toTransferJobRow(row) : null;
  }

  list(): TransferJobRow[] {
    const rows = this.database.prepare(`
      SELECT id, owner_id, kind, host_id, source_path, target_path, status, completed_bytes, total_bytes, error_code, checkpoint_offset, checkpoint_checksum, temporary_path, created_at, updated_at
      FROM transfer_jobs WHERE owner_id = @ownerId ORDER BY updated_at DESC
    `).all({ ownerId: this.ownerId }) as TransferJobSqlRow[];
    return rows.map(toTransferJobRow);
  }

  update(id: string, patch: TransferJobPatch): TransferJobRow {
    const current = this.get(id);
    if (!current) throw new AppError('TRANSFER_NOT_FOUND');
    this.database.prepare(`
      UPDATE transfer_jobs
      SET status = @status, completed_bytes = @completedBytes, total_bytes = @totalBytes,
          error_code = @errorCode, checkpoint_offset = @checkpointOffset,
          checkpoint_checksum = @checkpointChecksum, temporary_path = @temporaryPath,
          updated_at = @updatedAt
      WHERE id = @id AND owner_id = @ownerId
    `).run({
      id,
      ownerId: this.ownerId,
      status: patch.status ?? current.status,
      completedBytes: patch.completedBytes ?? current.completedBytes,
      totalBytes: patch.totalBytes === undefined ? current.totalBytes : patch.totalBytes,
      errorCode: patch.errorCode === undefined ? current.errorCode ?? null : patch.errorCode ?? null,
      checkpointOffset: patch.checkpointOffset ?? current.checkpoint?.offset ?? current.completedBytes,
      checkpointChecksum: patch.checkpointChecksum === undefined ? current.checkpoint?.checksum ?? null : patch.checkpointChecksum ?? null,
      temporaryPath: patch.temporaryPath === undefined ? current.temporaryPath : patch.temporaryPath,
      updatedAt: patch.updatedAt ?? current.updatedAt
    });
    const updated = this.get(id);
    if (!updated) throw new AppError('INTERNAL_ERROR');
    return updated;
  }

  markActiveInterrupted(errorCode: string, updatedAt: string): number {
    const result = this.database.prepare(`
      UPDATE transfer_jobs
      SET status = 'interrupted', error_code = @errorCode, updated_at = @updatedAt
      WHERE owner_id = @ownerId AND status IN ('queued', 'running')
    `).run({ ownerId: this.ownerId, errorCode, updatedAt });
    return result.changes;
  }

  deleteExpired(cutoff: string): void {
    this.database.prepare(`
      DELETE FROM transfer_jobs
      WHERE owner_id = @ownerId AND status IN ('paused', 'completed', 'failed', 'cancelled', 'interrupted') AND updated_at <= @cutoff
    `).run({ ownerId: this.ownerId, cutoff });
  }
}
