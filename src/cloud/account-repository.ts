import type { ClientPlatform, DeviceDescriptor } from '../shared/core/models.js';
import type { CloudSqlExecutor, CloudSqlTransaction } from './database.js';

export interface CloudAccountRecord {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudDeviceRecord {
  id: string;
  accountId: string;
  label: string;
  platform: ClientPlatform;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
}

export interface CloudSessionRecord {
  tokenHash: string;
  accountId: string;
  deviceId: string;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
  revokedAt: string | null;
}

interface AccountSqlRow {
  account_id: string;
  normalized_email: string;
  password_hash: string;
  created_at: string;
  updated_at: string;
}

interface DeviceSqlRow {
  device_id: string;
  account_id: string;
  platform: ClientPlatform;
  label: string;
  created_at: string;
  last_seen_at: string | null;
  revoked_at: string | null;
}

interface SessionSqlRow {
  token_hash: string;
  account_id: string;
  device_id: string;
  created_at: string;
  last_used_at: string;
  expires_at: string;
  revoked_at: string | null;
}

interface CloudRepositoryDatabase extends CloudSqlExecutor {
  transaction?<T>(work: (transaction: CloudSqlTransaction) => Promise<T>): Promise<T>;
}

const accountFromRow = (row: AccountSqlRow): CloudAccountRecord => ({
  id: row.account_id,
  email: row.normalized_email,
  passwordHash: row.password_hash,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

const deviceFromRow = (row: DeviceSqlRow): CloudDeviceRecord => ({
  id: row.device_id,
  accountId: row.account_id,
  label: row.label,
  platform: row.platform,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  revokedAt: row.revoked_at
});

const sessionFromRow = (row: SessionSqlRow): CloudSessionRecord => ({
  tokenHash: row.token_hash,
  accountId: row.account_id,
  deviceId: row.device_id,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at
});

const first = <T>(rows: readonly T[]): T | null => rows[0] ?? null;

export interface CreateCloudAccountInput {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface CreateCloudDeviceInput {
  id: string;
  accountId: string;
  label: string;
  platform: ClientPlatform;
  createdAt: string;
  publicKey?: string | null;
}

export class CloudAccountRepository {
  constructor(private readonly database: CloudRepositoryDatabase) {}

  async getAccountByEmail(email: string): Promise<CloudAccountRecord | null> {
    const rows = await this.database.query<AccountSqlRow[]>(
      'SELECT account_id, normalized_email, password_hash, created_at, updated_at FROM accounts WHERE normalized_email = ? LIMIT 1',
      [email]
    );
    const row = first(rows);
    return row ? accountFromRow(row) : null;
  }

  async getAccount(accountId: string): Promise<CloudAccountRecord | null> {
    const rows = await this.database.query<AccountSqlRow[]>(
      'SELECT account_id, normalized_email, password_hash, created_at, updated_at FROM accounts WHERE account_id = ? LIMIT 1',
      [accountId]
    );
    const row = first(rows);
    return row ? accountFromRow(row) : null;
  }

  async getDevice(accountId: string, deviceId: string): Promise<CloudDeviceRecord | null> {
    const rows = await this.database.query<DeviceSqlRow[]>(
      'SELECT device_id, account_id, platform, label, created_at, last_seen_at, revoked_at FROM devices WHERE account_id = ? AND device_id = ? LIMIT 1',
      [accountId, deviceId]
    );
    const row = first(rows);
    return row ? deviceFromRow(row) : null;
  }

  async createAccountWithDevice(account: CreateCloudAccountInput, device: CreateCloudDeviceInput): Promise<void> {
    const insert = async (executor: CloudSqlExecutor): Promise<void> => {
      await executor.execute(
        'INSERT INTO accounts (account_id, normalized_email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
        [account.id, account.email, account.passwordHash, account.createdAt, account.createdAt]
      );
      await executor.execute(
        'INSERT INTO devices (device_id, account_id, platform, label, public_key, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        [device.id, device.accountId, device.platform, device.label, device.publicKey ?? null, device.createdAt]
      );
    };
    if (this.database.transaction) {
      await this.database.transaction(insert);
      return;
    }
    await insert(this.database);
  }

  async createDevice(input: CreateCloudDeviceInput): Promise<void> {
    await this.database.execute(
      'INSERT INTO devices (device_id, account_id, platform, label, public_key, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [input.id, input.accountId, input.platform, input.label, input.publicKey ?? null, input.createdAt]
    );
  }

  async touchDevice(accountId: string, deviceId: string, at: string): Promise<void> {
    await this.database.execute(
      'UPDATE devices SET last_seen_at = ? WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL',
      [at, accountId, deviceId]
    );
  }

  async listDevices(accountId: string): Promise<readonly CloudDeviceRecord[]> {
    const rows = await this.database.query<DeviceSqlRow[]>(
      'SELECT device_id, account_id, platform, label, created_at, last_seen_at, revoked_at FROM devices WHERE account_id = ? AND revoked_at IS NULL ORDER BY created_at ASC',
      [accountId]
    );
    return rows.filter((row) => row.revoked_at === null).map(deviceFromRow);
  }

  async createSession(input: { tokenHash: string; accountId: string; deviceId: string; createdAt: string; expiresAt: string }): Promise<void> {
    await this.database.execute(
      'INSERT INTO device_sessions (token_hash, account_id, device_id, created_at, last_used_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)',
      [input.tokenHash, input.accountId, input.deviceId, input.createdAt, input.createdAt, input.expiresAt]
    );
  }

  async getSession(tokenHash: string): Promise<CloudSessionRecord | null> {
    const rows = await this.database.query<SessionSqlRow[]>(
      'SELECT token_hash, account_id, device_id, created_at, last_used_at, expires_at, revoked_at FROM device_sessions WHERE token_hash = ? LIMIT 1',
      [tokenHash]
    );
    const row = first(rows);
    return row ? sessionFromRow(row) : null;
  }

  async touchSession(tokenHash: string, at: string): Promise<void> {
    await this.database.execute(
      'UPDATE device_sessions SET last_used_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
      [at, tokenHash]
    );
  }

  async revokeSession(tokenHash: string, at: string): Promise<void> {
    await this.database.execute(
      'UPDATE device_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
      [at, tokenHash]
    );
  }

  async revokeDevice(accountId: string, deviceId: string, at: string): Promise<boolean> {
    const result = await this.database.execute<{ affectedRows?: number }>(
      'UPDATE devices SET revoked_at = ? WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL',
      [at, accountId, deviceId]
    );
    return (result.affectedRows ?? 0) === 1;
  }

  async revokeDeviceSessions(accountId: string, deviceId: string, at: string): Promise<void> {
    await this.database.execute(
      'UPDATE device_sessions SET revoked_at = ? WHERE account_id = ? AND device_id = ? AND revoked_at IS NULL',
      [at, accountId, deviceId]
    );
  }

  async listDeviceDescriptors(accountId: string, currentDeviceId: string): Promise<readonly DeviceDescriptor[]> {
    const devices = await this.listDevices(accountId);
    return devices.map((device) => ({
      id: device.id,
      label: device.label,
      platform: device.platform,
      lastSeenAt: device.lastSeenAt,
      current: device.id === currentDeviceId,
      revokedAt: device.revokedAt
    }));
  }
}
