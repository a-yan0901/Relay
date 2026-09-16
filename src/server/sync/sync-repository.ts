import { createHash, randomUUID } from 'node:crypto';

import type {
  SyncDescriptor,
  SyncEnvelope,
  SyncHead,
  SyncStatus,
  VaultUnlockEnvelope,
  WrappedKeyEnvelope
} from '../../shared/core/models.js';
import { AppError } from '../../shared/errors.js';
import { validateSyncEnvelope } from './sync-crypto.js';
import type { SqliteDatabase } from '../db/database.js';

export interface BlindSyncStore {
  getHead(accountId: string): SyncHead | null;
  getEnvelope(accountId: string, revision?: number): SyncEnvelope | null;
  putEnvelope(accountId: string, envelope: SyncEnvelope, idempotencyKey: string): SyncHead;
  getDescriptor(accountId: string): SyncDescriptor | null;
  saveDescriptor(accountId: string, descriptor: SyncDescriptor): void;
  saveConflict(accountId: string, local: SyncEnvelope, remote: SyncEnvelope): string;
  getConflict(accountId: string, conflictId: string): { local: SyncEnvelope; remote: SyncEnvelope } | null;
  resolveConflict(accountId: string, conflictId: string): void;
  deleteAccountVault(accountId: string, deleteAfter: string): void;
  getDeleteRequest(accountId: string): SyncDeleteRequest | null;
  restoreDeleteRequest(accountId: string): void;
  purgeExpiredVault(accountId: string, now?: string): boolean;
  getClientState(accountId: string): SyncClientState | null;
  saveClientState(accountId: string, state: SyncClientState): void;
  clearClientState(accountId: string): void;
}

export interface SyncDeleteRequest {
  deleteAfter: string;
  requestedAt: string;
}

export interface SyncClientState {
  pendingEnvelope: SyncEnvelope | null;
  status: SyncStatus;
  errorCode: string | null;
  updatedAt: string;
}

interface SyncEnvelopeSqlRow {
  account_id: string;
  revision: number;
  parent_revision: number | null;
  device_id: string;
  key_version: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  aad: string;
  payload_hash: string;
  byte_length: number;
  created_at: string;
}

interface DescriptorSqlRow {
  account_id: string;
  vault_id: string;
  key_version: number;
  vault_unlock_envelope_json: string;
  wrapped_sync_key_json: string;
}

interface ConflictSqlRow {
  local_envelope_json: string;
  remote_envelope_json: string;
}

interface DeleteRequestSqlRow {
  delete_after: string;
  requested_at: string;
}

interface ClientStateSqlRow {
  pending_envelope_json: string | null;
  status: SyncStatus;
  error_code: string | null;
  updated_at: string;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;
const SYNC_KEY_VERSION_MIN = 1;
const SYNC_KEY_VERSION_MAX = 32;
const SYNC_STATUSES: readonly SyncStatus[] = [
  'local-only', 'needs-unlock', 'syncing', 'synced', 'pending', 'offline', 'conflict', 'device-revoked'
];

const assertId = (value: string): void => {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) throw new AppError('SYNC_PAYLOAD_INVALID');
};

const assertAccount = (accountId: string): void => {
  if (typeof accountId !== 'string' || !SAFE_ID.test(accountId)) throw new AppError('SYNC_NOT_FOUND');
};

const assertVersion = (version: number): void => {
  if (!Number.isSafeInteger(version) || version < SYNC_KEY_VERSION_MIN || version > SYNC_KEY_VERSION_MAX) {
    throw new AppError('SYNC_KEY_VERSION_UNSUPPORTED');
  }
};

const hashIdempotencyKey = (value: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
};

const parseJsonObject = (value: string): Record<string, unknown> => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('object expected');
    return parsed as Record<string, unknown>;
  } catch {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
};

const parseWrappedKey = (value: unknown): WrappedKeyEnvelope => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.nonce !== 'string' ||
    typeof candidate.ciphertext !== 'string' ||
    typeof candidate.authTag !== 'string' ||
    typeof candidate.aad !== 'string'
  ) {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
  return {
    version: 1,
    nonce: candidate.nonce as string,
    ciphertext: candidate.ciphertext as string,
    authTag: candidate.authTag as string,
    aad: candidate.aad as string
  };
};

const parseUnlockEnvelope = (value: unknown): VaultUnlockEnvelope => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new AppError('SYNC_PAYLOAD_INVALID');
  const candidate = value as Record<string, unknown>;
  const kdf = candidate.kdf;
  if (
    candidate.version !== 1 ||
    typeof kdf !== 'object' ||
    kdf === null ||
    Array.isArray(kdf) ||
    typeof candidate.wrappedVaultKey !== 'object'
  ) {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
  const params = kdf as Record<string, unknown>;
  if (
    typeof params.algorithm !== 'string' ||
    typeof params.salt !== 'string' ||
    !Number.isSafeInteger(params.memoryCost) ||
    !Number.isSafeInteger(params.timeCost) ||
    !Number.isSafeInteger(params.parallelism) ||
    !Number.isSafeInteger(params.hashLength)
  ) {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
  return {
    version: 1,
    kdf: {
      algorithm: params.algorithm,
      salt: params.salt,
      memoryCost: params.memoryCost as number,
      timeCost: params.timeCost as number,
      parallelism: params.parallelism as number,
      hashLength: params.hashLength as number
    },
    wrappedVaultKey: parseWrappedKey(candidate.wrappedVaultKey),
    ...(candidate.recoveryWrappedVaultKey === undefined
      ? {}
      : { recoveryWrappedVaultKey: parseWrappedKey(candidate.recoveryWrappedVaultKey) })
  };
};

const parseClientStatus = (value: string): SyncStatus => {
  if (!(SYNC_STATUSES as readonly string[]).includes(value)) throw new AppError('SYNC_PAYLOAD_INVALID');
  return value as SyncStatus;
};

const parseDescriptor = (row: DescriptorSqlRow): SyncDescriptor => {
  const unlock = parseUnlockEnvelope(parseJsonObject(row.vault_unlock_envelope_json));
  const wrappedSyncKey = parseWrappedKey(parseJsonObject(row.wrapped_sync_key_json));
  return {
    vaultId: row.vault_id,
    keyVersion: row.key_version,
    vaultUnlockEnvelope: unlock,
    wrappedSyncKey
  };
};

const toEnvelope = (row: SyncEnvelopeSqlRow, vaultId: string): SyncEnvelope => validateSyncEnvelope({
  schemaVersion: 1,
  vaultId,
  revision: row.revision,
  parentRevision: row.parent_revision,
  deviceId: row.device_id,
  keyVersion: row.key_version,
  nonce: row.nonce,
  ciphertext: row.ciphertext,
  authTag: row.auth_tag,
  aad: row.aad,
  payloadHash: row.payload_hash,
  byteLength: row.byte_length
});

const envelopeFields = (envelope: SyncEnvelope): Omit<SyncEnvelope, 'schemaVersion' | 'vaultId'> => ({
  revision: envelope.revision,
  parentRevision: envelope.parentRevision,
  deviceId: envelope.deviceId,
  keyVersion: envelope.keyVersion,
  nonce: envelope.nonce,
  ciphertext: envelope.ciphertext,
  authTag: envelope.authTag,
  aad: envelope.aad,
  payloadHash: envelope.payloadHash,
  byteLength: envelope.byteLength
});

const sameEnvelope = (left: SyncEnvelope, right: SyncEnvelope): boolean => (
  left.vaultId === right.vaultId && JSON.stringify(envelopeFields(left)) === JSON.stringify(envelopeFields(right))
);

export class BlindSyncRepository implements BlindSyncStore {
  constructor(private readonly database: SqliteDatabase) {}

  getHead(accountId: string): SyncHead | null {
    assertAccount(accountId);
    const row = this.database.prepare(`
      SELECT v.vault_id, e.revision, e.key_version, e.payload_hash, e.created_at
      FROM sync_vaults v
      JOIN sync_envelopes e ON e.account_id = v.account_id
      WHERE v.account_id = @accountId
      ORDER BY e.revision DESC
      LIMIT 1
    `).get({ accountId }) as {
      vault_id: string;
      revision: number;
      key_version: number;
      payload_hash: string;
      created_at: string;
    } | undefined;
    if (!row) return null;
    return {
      vaultId: row.vault_id,
      revision: row.revision,
      keyVersion: row.key_version,
      payloadHash: row.payload_hash,
      updatedAt: row.created_at
    };
  }

  getEnvelope(accountId: string, revision?: number): SyncEnvelope | null {
    assertAccount(accountId);
    const row = this.database.prepare(`
      SELECT account_id, revision, parent_revision, device_id, key_version,
             nonce, ciphertext, auth_tag, aad, payload_hash, byte_length, created_at
      FROM sync_envelopes
      WHERE account_id = @accountId
        AND (@revision IS NULL OR revision = @revision)
      ORDER BY revision DESC
      LIMIT 1
    `).get({ accountId, revision: revision ?? null }) as SyncEnvelopeSqlRow | undefined;
    if (!row) return null;
    return toEnvelope(row, this.vaultIdFor(accountId));
  }

  putEnvelope(accountId: string, envelope: SyncEnvelope, idempotencyKey: string): SyncHead {
    assertAccount(accountId);
    const candidate = validateSyncEnvelope(envelope);
    const idempotencyHash = hashIdempotencyKey(idempotencyKey);
    const operation = this.database.transaction(() => {
      const account = this.database.prepare('SELECT id FROM accounts WHERE id = @accountId').get({ accountId });
      if (!account) throw new AppError('SYNC_NOT_FOUND');
      const descriptor = this.database.prepare(`
        SELECT account_id, vault_id, key_version, vault_unlock_envelope_json, wrapped_sync_key_json
        FROM sync_vaults WHERE account_id = @accountId
      `).get({ accountId }) as DescriptorSqlRow | undefined;
      if (!descriptor) throw new AppError('SYNC_NOT_FOUND');
      assertVersion(descriptor.key_version);
      if (candidate.vaultId !== descriptor.vault_id || candidate.keyVersion !== descriptor.key_version) {
        throw new AppError('SYNC_PAYLOAD_INVALID');
      }
      const device = this.database.prepare(`
        SELECT id FROM account_devices
        WHERE account_id = @accountId AND id = @deviceId AND revoked_at IS NULL
      `).get({ accountId, deviceId: candidate.deviceId });
      if (!device) throw new AppError('ACCOUNT_DEVICE_REVOKED');

      const priorByIdempotency = this.database.prepare(`
        SELECT account_id, revision, parent_revision, device_id, key_version,
               nonce, ciphertext, auth_tag, aad, payload_hash, byte_length, created_at
        FROM sync_envelopes
        WHERE account_id = @accountId AND idempotency_key_hash = @idempotencyHash
      `).get({ accountId, idempotencyHash }) as SyncEnvelopeSqlRow | undefined;
      if (priorByIdempotency) {
        const prior = toEnvelope(priorByIdempotency, descriptor.vault_id);
        if (!sameEnvelope(prior, candidate)) throw new AppError('SYNC_CONFLICT');
        return this.getHead(accountId) ?? this.headFromEnvelope(candidate);
      }

      const current = this.getEnvelope(accountId);
      const expectedRevision = (current?.revision ?? 0) + 1;
      const expectedParent = current?.revision ?? null;
      if (candidate.revision !== expectedRevision || candidate.parentRevision !== expectedParent) {
        throw new AppError('SYNC_CONFLICT');
      }

      const createdAt = new Date().toISOString();
      try {
        this.database.prepare(`
          INSERT INTO sync_envelopes (
            account_id, revision, parent_revision, device_id, key_version,
            nonce, ciphertext, auth_tag, aad, payload_hash, byte_length,
            idempotency_key_hash, created_at
          ) VALUES (
            @accountId, @revision, @parentRevision, @deviceId, @keyVersion,
            @nonce, @ciphertext, @authTag, @aad, @payloadHash, @byteLength,
            @idempotencyHash, @createdAt
          )
        `).run({
          accountId,
          ...envelopeFields(candidate),
          idempotencyHash,
          createdAt
        });
      } catch (error) {
        if (error instanceof Error && error.message.includes('UNIQUE constraint failed')) {
          throw new AppError('SYNC_CONFLICT');
        }
        throw error;
      }
      return {
        vaultId: descriptor.vault_id,
        revision: candidate.revision,
        keyVersion: candidate.keyVersion,
        payloadHash: candidate.payloadHash,
        updatedAt: createdAt
      };
    });
    return operation();
  }

  getDescriptor(accountId: string): SyncDescriptor | null {
    assertAccount(accountId);
    const row = this.database.prepare(`
      SELECT account_id, vault_id, key_version, vault_unlock_envelope_json, wrapped_sync_key_json
      FROM sync_vaults WHERE account_id = @accountId
    `).get({ accountId }) as DescriptorSqlRow | undefined;
    return row ? parseDescriptor(row) : null;
  }

  saveDescriptor(accountId: string, descriptor: SyncDescriptor): void {
    assertAccount(accountId);
    assertId(descriptor.vaultId);
    assertVersion(descriptor.keyVersion);
    parseUnlockEnvelope(descriptor.vaultUnlockEnvelope);
    parseWrappedKey(descriptor.wrappedSyncKey);
    const existing = this.getDescriptor(accountId);
    if (existing && existing.vaultId !== descriptor.vaultId) throw new AppError('SYNC_CONFLICT');
    const timestamp = new Date().toISOString();
    const result = this.database.prepare('SELECT id FROM accounts WHERE id = @accountId').get({ accountId });
    if (!result) throw new AppError('SYNC_NOT_FOUND');
    this.database.prepare(`
      INSERT INTO sync_vaults (
        account_id, vault_id, key_version, vault_unlock_envelope_json,
        wrapped_sync_key_json, created_at, updated_at
      ) VALUES (@accountId, @vaultId, @keyVersion, @unlock, @wrapped, @createdAt, @updatedAt)
      ON CONFLICT(account_id) DO UPDATE SET
        key_version = excluded.key_version,
        vault_unlock_envelope_json = excluded.vault_unlock_envelope_json,
        wrapped_sync_key_json = excluded.wrapped_sync_key_json,
        updated_at = excluded.updated_at
    `).run({
      accountId,
      vaultId: descriptor.vaultId,
      keyVersion: descriptor.keyVersion,
      unlock: JSON.stringify(descriptor.vaultUnlockEnvelope),
      wrapped: JSON.stringify(descriptor.wrappedSyncKey),
      createdAt: timestamp,
      updatedAt: timestamp
    });
  }

  saveConflict(accountId: string, local: SyncEnvelope, remote: SyncEnvelope): string {
    assertAccount(accountId);
    const localEnvelope = validateSyncEnvelope(local);
    const remoteEnvelope = validateSyncEnvelope(remote);
    if (localEnvelope.vaultId !== remoteEnvelope.vaultId) throw new AppError('SYNC_PAYLOAD_INVALID');
    if (!this.getDescriptor(accountId)) throw new AppError('SYNC_NOT_FOUND');
    const id = randomUUID();
    this.database.prepare(`
      INSERT INTO sync_conflicts (
        id, account_id, local_revision, remote_revision,
        local_envelope_json, remote_envelope_json, created_at, resolved_at
      ) VALUES (@id, @accountId, @localRevision, @remoteRevision, @local, @remote, @createdAt, NULL)
    `).run({
      id,
      accountId,
      localRevision: localEnvelope.revision,
      remoteRevision: remoteEnvelope.revision,
      local: JSON.stringify(localEnvelope),
      remote: JSON.stringify(remoteEnvelope),
      createdAt: new Date().toISOString()
    });
    return id;
  }

  getConflict(accountId: string, conflictId: string): { local: SyncEnvelope; remote: SyncEnvelope } | null {
    assertAccount(accountId);
    assertId(conflictId);
    const row = this.database.prepare(`
      SELECT local_envelope_json, remote_envelope_json
      FROM sync_conflicts WHERE account_id = @accountId AND id = @conflictId AND resolved_at IS NULL
    `).get({ accountId, conflictId }) as ConflictSqlRow | undefined;
    if (!row) return null;
    return {
      local: validateSyncEnvelope(JSON.parse(row.local_envelope_json) as unknown),
      remote: validateSyncEnvelope(JSON.parse(row.remote_envelope_json) as unknown)
    };
  }

  resolveConflict(accountId: string, conflictId: string): void {
    assertAccount(accountId);
    assertId(conflictId);
    const result = this.database.prepare(`
      UPDATE sync_conflicts
      SET resolved_at = @resolvedAt
      WHERE account_id = @accountId AND id = @conflictId AND resolved_at IS NULL
    `).run({ accountId, conflictId, resolvedAt: new Date().toISOString() });
    if (result.changes === 0) throw new AppError('SYNC_NOT_FOUND');
  }

  deleteAccountVault(accountId: string, deleteAfter: string): void {
    assertAccount(accountId);
    if (!Number.isFinite(Date.parse(deleteAfter))) throw new AppError('SYNC_PAYLOAD_INVALID');
    const account = this.database.prepare('SELECT id FROM accounts WHERE id = @accountId').get({ accountId });
    if (!account) throw new AppError('SYNC_NOT_FOUND');
    this.database.prepare(`
      INSERT INTO sync_delete_requests (account_id, delete_after, requested_at, restored_at)
      VALUES (@accountId, @deleteAfter, @requestedAt, NULL)
      ON CONFLICT(account_id) DO UPDATE SET delete_after = excluded.delete_after, requested_at = excluded.requested_at, restored_at = NULL
    `).run({ accountId, deleteAfter: new Date(Date.parse(deleteAfter)).toISOString(), requestedAt: new Date().toISOString() });
  }

  getDeleteRequest(accountId: string): SyncDeleteRequest | null {
    assertAccount(accountId);
    const row = this.database.prepare(`
      SELECT delete_after, requested_at
      FROM sync_delete_requests
      WHERE account_id = @accountId AND restored_at IS NULL
    `).get({ accountId }) as DeleteRequestSqlRow | undefined;
    if (!row) return null;
    if (!Number.isFinite(Date.parse(row.delete_after)) || !Number.isFinite(Date.parse(row.requested_at))) {
      throw new AppError('SYNC_PAYLOAD_INVALID');
    }
    return { deleteAfter: new Date(row.delete_after).toISOString(), requestedAt: new Date(row.requested_at).toISOString() };
  }

  restoreDeleteRequest(accountId: string): void {
    assertAccount(accountId);
    const result = this.database.prepare(`
      UPDATE sync_delete_requests
      SET restored_at = @restoredAt
      WHERE account_id = @accountId AND restored_at IS NULL
    `).run({ accountId, restoredAt: new Date().toISOString() });
    if (result.changes === 0) throw new AppError('SYNC_NOT_FOUND');
  }

  purgeExpiredVault(accountId: string, now = new Date().toISOString()): boolean {
    assertAccount(accountId);
    if (!Number.isFinite(Date.parse(now))) throw new AppError('SYNC_PAYLOAD_INVALID');
    const operation = this.database.transaction(() => {
      const request = this.database.prepare(`
        SELECT account_id FROM sync_delete_requests
        WHERE account_id = @accountId AND restored_at IS NULL AND delete_after <= @now
      `).get({ accountId, now: new Date(Date.parse(now)).toISOString() });
      if (!request) return false;
      this.database.prepare('DELETE FROM sync_client_state WHERE account_id = @accountId').run({ accountId });
      this.database.prepare('DELETE FROM sync_conflicts WHERE account_id = @accountId').run({ accountId });
      this.database.prepare('DELETE FROM sync_envelopes WHERE account_id = @accountId').run({ accountId });
      this.database.prepare('DELETE FROM sync_vaults WHERE account_id = @accountId').run({ accountId });
      this.database.prepare('DELETE FROM sync_delete_requests WHERE account_id = @accountId').run({ accountId });
      return true;
    });
    return operation();
  }

  getClientState(accountId: string): SyncClientState | null {
    assertAccount(accountId);
    const row = this.database.prepare(`
      SELECT pending_envelope_json, status, error_code, updated_at
      FROM sync_client_state
      WHERE account_id = @accountId
    `).get({ accountId }) as ClientStateSqlRow | undefined;
    if (!row) return null;
    const pendingEnvelope = row.pending_envelope_json === null
      ? null
      : validateSyncEnvelope(JSON.parse(row.pending_envelope_json) as unknown);
    if (!Number.isFinite(Date.parse(row.updated_at))) throw new AppError('SYNC_PAYLOAD_INVALID');
    return {
      pendingEnvelope,
      status: parseClientStatus(row.status),
      errorCode: row.error_code,
      updatedAt: new Date(row.updated_at).toISOString()
    };
  }

  saveClientState(accountId: string, state: SyncClientState): void {
    assertAccount(accountId);
    const account = this.database.prepare('SELECT id FROM accounts WHERE id = @accountId').get({ accountId });
    if (!account) throw new AppError('SYNC_NOT_FOUND');
    const status = parseClientStatus(state.status);
    const pendingEnvelope = state.pendingEnvelope === null ? null : validateSyncEnvelope(state.pendingEnvelope);
    if (!Number.isFinite(Date.parse(state.updatedAt))) throw new AppError('SYNC_PAYLOAD_INVALID');
    if (state.errorCode !== null && (typeof state.errorCode !== 'string' || state.errorCode.length > 128)) throw new AppError('SYNC_PAYLOAD_INVALID');
    this.database.prepare(`
      INSERT INTO sync_client_state (account_id, pending_envelope_json, status, error_code, updated_at)
      VALUES (@accountId, @pendingEnvelope, @status, @errorCode, @updatedAt)
      ON CONFLICT(account_id) DO UPDATE SET
        pending_envelope_json = excluded.pending_envelope_json,
        status = excluded.status,
        error_code = excluded.error_code,
        updated_at = excluded.updated_at
    `).run({
      accountId,
      pendingEnvelope: pendingEnvelope === null ? null : JSON.stringify(pendingEnvelope),
      status,
      errorCode: state.errorCode,
      updatedAt: new Date(Date.parse(state.updatedAt)).toISOString()
    });
  }

  clearClientState(accountId: string): void {
    assertAccount(accountId);
    this.database.prepare('DELETE FROM sync_client_state WHERE account_id = @accountId').run({ accountId });
  }

  private vaultIdFor(accountId: string): string {
    const row = this.database.prepare('SELECT vault_id FROM sync_vaults WHERE account_id = @accountId').get({ accountId }) as { vault_id: string } | undefined;
    if (!row) throw new AppError('SYNC_NOT_FOUND');
    return row.vault_id;
  }

  private headFromEnvelope(envelope: SyncEnvelope): SyncHead {
    return {
      vaultId: envelope.vaultId,
      revision: envelope.revision,
      keyVersion: envelope.keyVersion,
      payloadHash: envelope.payloadHash,
      updatedAt: new Date().toISOString()
    };
  }
}
