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
});
