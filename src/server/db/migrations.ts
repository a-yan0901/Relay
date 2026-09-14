import type { SqliteDatabase } from './database.js';

const SCHEMA_VERSION = 1;

export const migrate = (database: SqliteDatabase): void => {
  const applyMigration = database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS app_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        schema_version INTEGER NOT NULL,
        kdf_algorithm TEXT NOT NULL,
        kdf_params_json TEXT NOT NULL,
        kdf_salt TEXT NOT NULL,
        wrapped_vault_key TEXT NOT NULL,
        wrapped_vault_key_nonce TEXT NOT NULL,
        wrapped_vault_key_tag TEXT NOT NULL,
        wrapped_vault_key_aad TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, name)
      );

      CREATE TABLE IF NOT EXISTS hosts (
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
        is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
        last_connected_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS audit_events (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT 'default',
        event_type TEXT NOT NULL,
        host_id TEXT REFERENCES hosts(id) ON DELETE SET NULL,
        request_id TEXT NOT NULL,
        remote_address TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_groups_owner_sort
        ON groups (owner_id, sort_order, name);
      CREATE INDEX IF NOT EXISTS idx_hosts_owner_name
        ON hosts (owner_id, name COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_hosts_owner_address
        ON hosts (owner_id, address COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_hosts_owner_recent
        ON hosts (owner_id, last_connected_at DESC);
      CREATE INDEX IF NOT EXISTS idx_hosts_owner_group
        ON hosts (owner_id, group_id);
      CREATE INDEX IF NOT EXISTS idx_audit_owner_created
        ON audit_events (owner_id, created_at DESC);
    `);

    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  });

  applyMigration();
};
