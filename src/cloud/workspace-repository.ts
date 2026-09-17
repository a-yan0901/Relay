import { randomUUID } from 'node:crypto';

import type { CloudSqlExecutor, CloudSqlTransaction } from './database.js';

const MAX_CLOUD_WORKSPACES_PER_ACCOUNT = 256;

export interface CloudWorkspaceDescriptor {
  id: string;
  accountId: string;
  ownerDeviceId: string;
  encryptedTitle: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

interface WorkspaceSqlRow {
  workspace_id: string;
  account_id: string;
  owner_device_id: string;
  encrypted_title: string;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

interface WorkspaceDatabase extends CloudSqlExecutor {
  transaction?<T>(work: (transaction: CloudSqlTransaction) => Promise<T>): Promise<T>;
}

const fromRow = (row: WorkspaceSqlRow): CloudWorkspaceDescriptor => ({
  id: row.workspace_id,
  accountId: row.account_id,
  ownerDeviceId: row.owner_device_id,
  encryptedTitle: row.encrypted_title,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  deletedAt: row.deleted_at
});

const workspaceSelect = 'SELECT workspace_id, account_id, owner_device_id, encrypted_title, created_at, updated_at, deleted_at FROM workspaces';

export class CloudWorkspaceRepository {
  constructor(private readonly database: WorkspaceDatabase) {}

  async list(accountId: string): Promise<readonly CloudWorkspaceDescriptor[]> {
    const rows = await this.database.query<WorkspaceSqlRow[]>(
      `${workspaceSelect} WHERE account_id = ? AND deleted_at IS NULL ORDER BY created_at ASC LIMIT ${MAX_CLOUD_WORKSPACES_PER_ACCOUNT}`,
      [accountId]
    );
    return rows.filter((row) => row.deleted_at === null).map(fromRow);
  }

  async get(accountId: string, workspaceId: string): Promise<CloudWorkspaceDescriptor | null> {
    const rows = await this.database.query<WorkspaceSqlRow[]>(
      `${workspaceSelect} WHERE account_id = ? AND workspace_id = ? AND deleted_at IS NULL LIMIT 1`,
      [accountId, workspaceId]
    );
    const row = rows[0];
    return row && row.deleted_at === null ? fromRow(row) : null;
  }

  async canOwn(accountId: string, deviceId: string, workspaceId: string): Promise<boolean> {
    const rows = await this.database.query<Array<{ workspace_id: string }>>(
      'SELECT workspace_id FROM workspaces WHERE workspace_id = ? AND account_id = ? AND owner_device_id = ? AND deleted_at IS NULL LIMIT 1',
      [workspaceId, accountId, deviceId]
    );
    return rows.length > 0;
  }

  async canView(accountId: string, deviceId: string, workspaceId: string): Promise<boolean> {
    const rows = await this.database.query<Array<{ workspace_id: string }>>(
      `SELECT w.workspace_id
       FROM workspaces w
       INNER JOIN workspace_memberships m ON m.workspace_id = w.workspace_id AND m.device_id = ? AND m.revoked_at IS NULL
       INNER JOIN devices d ON d.account_id = w.account_id AND d.device_id = m.device_id
       WHERE w.workspace_id = ? AND w.account_id = ? AND d.revoked_at IS NULL AND w.deleted_at IS NULL LIMIT 1`,
      [deviceId, workspaceId, accountId]
    );
    return rows.length > 0;
  }

  async grantDeviceAccess(accountId: string, deviceId: string, now: string): Promise<void> {
    await this.database.execute(
      `INSERT INTO workspace_memberships (workspace_id, device_id, role, created_at)
       SELECT w.workspace_id, ?, 'member', ?
       FROM workspaces w
       INNER JOIN devices d ON d.account_id = w.account_id AND d.device_id = ? AND d.revoked_at IS NULL
       WHERE w.account_id = ? AND w.owner_device_id <> ? AND w.deleted_at IS NULL
       ON DUPLICATE KEY UPDATE role = VALUES(role), revoked_at = NULL`,
      [deviceId, now, deviceId, accountId, deviceId]
    );
  }

  async ensurePrimaryWorkspace(accountId: string, deviceId: string, encryptedTitle: string, now: string): Promise<CloudWorkspaceDescriptor> {
    const existing = await this.findByOwner(accountId, deviceId);
    if (existing) return existing;
    const workspaceId = randomUUID();
    const insert = async (executor: CloudSqlExecutor): Promise<void> => {
      await executor.execute(
        'INSERT INTO workspaces (workspace_id, account_id, owner_device_id, encrypted_title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        [workspaceId, accountId, deviceId, encryptedTitle, now, now]
      );
      await executor.execute(
        'INSERT INTO workspace_memberships (workspace_id, device_id, role, created_at) VALUES (?, ?, ?, ?)',
        [workspaceId, deviceId, 'owner', now]
      );
    };
    try {
      if (this.database.transaction) await this.database.transaction(insert);
      else await insert(this.database);
    } catch {
      const raced = await this.findByOwner(accountId, deviceId);
      if (raced) return raced;
      throw new Error('workspace creation failed');
    }
    const created = await this.get(accountId, workspaceId);
    if (!created) throw new Error('workspace creation failed');
    return created;
  }

  private async findByOwner(accountId: string, deviceId: string): Promise<CloudWorkspaceDescriptor | null> {
    const rows = await this.database.query<WorkspaceSqlRow[]>(
      `${workspaceSelect} WHERE account_id = ? AND owner_device_id = ? AND deleted_at IS NULL LIMIT 1`,
      [accountId, deviceId]
    );
    const row = rows[0];
    return row && row.deleted_at === null ? fromRow(row) : null;
  }
}
