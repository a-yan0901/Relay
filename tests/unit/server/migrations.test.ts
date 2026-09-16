import { afterEach, describe, expect, it } from 'vitest';

import { HostRepository } from '../../../src/server/db/repositories.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';
import { resolveConnectionConfiguration } from '../../../src/shared/core/connection-resolution.js';

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('database migrations', () => {
  it('preserves legacy host connection profiles as explicit overrides', () => {
    const database = openDatabase(':memory:');
    databases.push(database);
    database.exec(`
      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, name)
      );
      CREATE TABLE hosts (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        address TEXT NOT NULL,
        port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
        username TEXT NOT NULL,
        auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'private_key')),
        credential_ciphertext TEXT NOT NULL,
        credential_version INTEGER NOT NULL DEFAULT 1,
        host_key_algorithm TEXT,
        host_key_fingerprint TEXT,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        jump_host_ids_json TEXT NOT NULL DEFAULT '[]',
        connection_profile_json TEXT NOT NULL,
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
        last_connected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO groups (id, owner_id, name, sort_order, created_at, updated_at)
        VALUES ('group-1', 'owner-a', 'Production', 0, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      INSERT INTO hosts (
        id, owner_id, name, address, port, username, auth_type, credential_ciphertext,
        credential_version, group_id, connection_profile_json, created_at, updated_at
      ) VALUES (
        'host-1', 'owner-a', 'Legacy host', '10.0.0.8', 22, 'deploy', 'password', 'legacy-ciphertext',
        1, 'group-1', '{"keepaliveIntervalMs":12000,"keepaliveCountMax":7,"reconnect":{"enabled":true,"maxAttempts":2,"baseDelayMs":300,"maxDelayMs":2000}}',
        '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
      );
    `);

    migrate(database);

    const host = new HostRepository(database, 'owner-a').getForConnection('host-1');
    expect(host?.connectionProfileOverrides).toEqual({
      keepaliveIntervalMs: 12_000,
      keepaliveCountMax: 7,
      reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 2_000 }
    });
    expect(resolveConnectionConfiguration(host!, [{
      id: 'group-1', name: 'Production', parentId: null, sortOrder: 0,
      defaultIdentityId: null, connectionProfile: { keepaliveCountMax: 9 }
    }]).profile).toEqual({
      keepaliveIntervalMs: 12_000,
      keepaliveCountMax: 7,
      reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 2_000 }
    });
  });

  it('migrates existing transfer jobs to the pausable lifecycle without losing checkpoints', () => {
    const database = openDatabase(':memory:');
    databases.push(database);
    migrate(database);
    database.pragma('foreign_keys = OFF');
    database.exec('DROP INDEX idx_transfer_jobs_owner_updated; DROP TABLE transfer_jobs;');
    database.exec(`
      CREATE TABLE transfer_jobs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT 'default',
        kind TEXT NOT NULL CHECK (kind IN ('upload', 'download')),
        host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE,
        source_path TEXT NOT NULL,
        target_path TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        completed_bytes INTEGER NOT NULL DEFAULT 0 CHECK (completed_bytes >= 0),
        total_bytes INTEGER CHECK (total_bytes IS NULL OR total_bytes >= 0),
        error_code TEXT,
        checkpoint_offset INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_offset >= 0),
        checkpoint_checksum TEXT,
        temporary_path TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO transfer_jobs (id, owner_id, kind, host_id, source_path, target_path, status, completed_bytes, total_bytes, checkpoint_offset, checkpoint_checksum, temporary_path, created_at, updated_at)
      VALUES ('transfer-legacy', 'owner-a', 'upload', 'host-legacy', 'local.bin', '/remote.bin', 'interrupted', 4, 10, 4, 'a', '/remote.bin.tmp', '2026-09-16T00:00:00.000Z', '2026-09-16T00:00:01.000Z');
    `);
    database.pragma('foreign_keys = ON');

    migrate(database);

    const table = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transfer_jobs'").get() as { sql: string };
    expect(table.sql).toContain("'paused'");
    expect(database.prepare('SELECT status, checkpoint_offset, temporary_path FROM transfer_jobs WHERE id = ?').get('transfer-legacy')).toEqual({ status: 'interrupted', checkpoint_offset: 4, temporary_path: '/remote.bin.tmp' });
    expect(database.pragma('user_version', { simple: true })).toBe(13);
  });

  it('adds account metadata tables without rebuilding existing Vault and host data', () => {
    const database = openDatabase(':memory:');
    databases.push(database);
    migrate(database);
    database.exec(`
      INSERT INTO hosts (
        id, owner_id, name, address, port, username, auth_type, credential_ciphertext,
        credential_version, created_at, updated_at
      ) VALUES ('legacy-host', 'default', 'Legacy host', '10.0.0.8', 22, 'deploy', 'password', 'ciphertext', 1, '2026-01-01', '2026-01-01');
    `);

    migrate(database);

    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('accounts', 'account_devices', 'account_sessions') ORDER BY name").all())
      .toEqual([
        { name: 'account_devices' },
        { name: 'account_sessions' },
        { name: 'accounts' }
      ]);
    expect(database.prepare('SELECT name, address, credential_ciphertext FROM hosts WHERE id = ?').get('legacy-host'))
      .toEqual({ name: 'Legacy host', address: '10.0.0.8', credential_ciphertext: 'ciphertext' });
    expect(database.pragma('user_version', { simple: true })).toBe(13);
  });
});
