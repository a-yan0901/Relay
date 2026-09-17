import {
  CLOUD_WRAPPED_KEY_MAX_BYTES,
  parseCloudKeyGrant,
  type CloudDataDomain,
  type CloudKeyGrant,
  type CloudKeyGrantInput
} from '../shared/cloud/protocol.js';
import { AppError } from '../shared/errors.js';
import type { CloudSqlExecutor } from './database.js';

interface CloudKeyDatabase extends CloudSqlExecutor {}

interface KeySqlRow {
  key_version: number;
  device_id: string;
  wrapped_key_json: unknown;
  created_at: string;
  revoked_at: string | null;
}

const assertWrappedKey = (value: unknown): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
  if (new TextEncoder().encode(serialized).byteLength > CLOUD_WRAPPED_KEY_MAX_BYTES) {
    throw new AppError('FILE_TOO_LARGE');
  }
  return value as Record<string, unknown>;
};

const parseStoredWrappedKey = (value: unknown): Record<string, unknown> => {
  if (typeof value === 'string') {
    try {
      return assertWrappedKey(JSON.parse(value));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('SYNC_PAYLOAD_INVALID');
    }
  }
  return assertWrappedKey(value);
};

const toGrant = (
  domain: CloudDataDomain,
  accountId: string,
  resourceId: string,
  row: KeySqlRow
): CloudKeyGrant => ({
  protocolVersion: 1,
  domain,
  accountId,
  resourceId,
  recipientDeviceId: row.device_id,
  keyVersion: row.key_version,
  wrappedKey: parseStoredWrappedKey(row.wrapped_key_json),
  createdAt: row.created_at,
  revokedAt: row.revoked_at
});

const assertGrantMatches = (input: CloudKeyGrantInput, domain: CloudDataDomain, resourceId: string): void => {
  const parsed = parseCloudKeyGrant(input);
  if (
    parsed.domain !== domain ||
    parsed.resourceId !== resourceId ||
    parsed.accountId.length === 0
  ) {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
};

export class CloudKeyRepository {
  constructor(private readonly database: CloudKeyDatabase) {}

  async listAccountDataKeys(accountId: string, recipientDeviceId: string): Promise<readonly CloudKeyGrant[]> {
    const rows = await this.database.query<KeySqlRow[]>(
      'SELECT key_version, device_id, wrapped_key_json, created_at, revoked_at FROM account_data_keys WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL ORDER BY key_version DESC',
      [accountId, recipientDeviceId]
    );
    return rows.filter((row) => row.revoked_at === null).map((row) => toGrant('account-data', accountId, accountId, row));
  }

  async putAccountDataKey(input: CloudKeyGrantInput, now: string): Promise<CloudKeyGrant> {
    assertGrantMatches(input, 'account-data', input.accountId);
    const wrappedKey = assertWrappedKey(input.wrappedKey);
    await this.assertActiveDevice(input.accountId, input.recipientDeviceId);
    await this.database.execute(
      `INSERT INTO account_data_keys (account_id, key_version, device_id, wrapped_key_json, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON DUPLICATE KEY UPDATE wrapped_key_json = VALUES(wrapped_key_json), created_at = VALUES(created_at), revoked_at = NULL`,
      [input.accountId, input.keyVersion, input.recipientDeviceId, JSON.stringify(wrappedKey), now]
    );
    return {
      ...input,
      wrappedKey,
      createdAt: now,
      revokedAt: null
    };
  }

  async listWorkspaceKeys(accountId: string, workspaceId: string, recipientDeviceId: string): Promise<readonly CloudKeyGrant[]> {
    const rows = await this.database.query<KeySqlRow[]>(
      `SELECT k.key_version, k.device_id, k.wrapped_key_json, k.created_at, k.revoked_at
       FROM workspace_keys k
       INNER JOIN workspaces w ON w.workspace_id = k.workspace_id AND w.account_id = ? AND w.deleted_at IS NULL
       WHERE k.workspace_id = ? AND k.device_id = ? AND k.revoked_at IS NULL ORDER BY k.key_version DESC`,
      [accountId, workspaceId, recipientDeviceId]
    );
    return rows.filter((row) => row.revoked_at === null).map((row) => toGrant('workspace', accountId, workspaceId, row));
  }

  async putWorkspaceKey(input: CloudKeyGrantInput, now: string): Promise<CloudKeyGrant> {
    assertGrantMatches(input, 'workspace', input.resourceId);
    const wrappedKey = assertWrappedKey(input.wrappedKey);
    await this.assertActiveWorkspaceMember(input.accountId, input.resourceId, input.recipientDeviceId);
    await this.database.execute(
      `INSERT INTO workspace_keys (workspace_id, key_version, device_id, wrapped_key_json, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, NULL)
       ON DUPLICATE KEY UPDATE wrapped_key_json = VALUES(wrapped_key_json), created_at = VALUES(created_at), revoked_at = NULL`,
      [input.resourceId, input.keyVersion, input.recipientDeviceId, JSON.stringify(wrappedKey), now]
    );
    return {
      ...input,
      wrappedKey,
      createdAt: now,
      revokedAt: null
    };
  }

  private async assertActiveDevice(accountId: string, deviceId: string): Promise<void> {
    const rows = await this.database.query<Array<{ device_id: string }>>(
      'SELECT device_id FROM devices WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL LIMIT 1',
      [accountId, deviceId]
    );
    if (rows.length === 0) throw new AppError('ACCOUNT_DEVICE_REVOKED');
  }

  private async assertActiveWorkspaceMember(accountId: string, workspaceId: string, deviceId: string): Promise<void> {
    const rows = await this.database.query<Array<{ device_id: string }>>(
      `SELECT m.device_id
       FROM workspace_memberships m
       INNER JOIN workspaces w ON w.workspace_id = m.workspace_id AND w.account_id = ? AND w.deleted_at IS NULL
       INNER JOIN devices d ON d.device_id = m.device_id AND d.account_id = ? AND d.revoked_at IS NULL
       WHERE m.workspace_id = ? AND m.device_id = ? AND m.revoked_at IS NULL LIMIT 1`,
      [accountId, accountId, workspaceId, deviceId]
    );
    if (rows.length === 0) throw new AppError('ACCOUNT_DEVICE_REVOKED');
  }
}
