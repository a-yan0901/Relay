import type { SqliteDatabase } from './database.js';

const SCHEMA_VERSION = 6;

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
        jump_host_ids_json TEXT NOT NULL DEFAULT '[]',
        connection_profile_json TEXT NOT NULL DEFAULT '{"keepaliveIntervalMs":10000,"keepaliveCountMax":3,"reconnect":{"enabled":true,"maxAttempts":5,"baseDelayMs":250,"maxDelayMs":5000}}',
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
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_snapshots (
        owner_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version >= 0),
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_templates (
        owner_id TEXT NOT NULL,
        id TEXT NOT NULL,
        name TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (owner_id, id),
        UNIQUE (owner_id, name)
      );

      CREATE TABLE IF NOT EXISTS snippets (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        description TEXT,
        tags_json TEXT NOT NULL DEFAULT '[]',
        command_ciphertext TEXT NOT NULL,
        variables_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, name)
      );

      CREATE TABLE IF NOT EXISTS command_runs (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT 'default',
        command_ciphertext TEXT NOT NULL,
        host_ids_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        persist_output INTEGER NOT NULL DEFAULT 0 CHECK (persist_output IN (0, 1)),
        created_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS command_run_targets (
        run_id TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT 'default',
        host_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        exit_code INTEGER,
        output_ciphertext TEXT,
        output_bytes INTEGER NOT NULL DEFAULT 0,
        output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
        error_code TEXT,
        started_at TEXT,
        finished_at TEXT,
        PRIMARY KEY (run_id, host_id),
        FOREIGN KEY (run_id) REFERENCES command_runs(id) ON DELETE CASCADE
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
      CREATE INDEX IF NOT EXISTS idx_workspace_templates_owner_updated
        ON workspace_templates (owner_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_snippets_owner_updated
        ON snippets (owner_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_command_runs_owner_created
        ON command_runs (owner_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_command_run_targets_owner_run
        ON command_run_targets (owner_id, run_id);
    `);

    const hostColumns = database.pragma('table_info(hosts)') as Array<{ name: string }>;
    if (!hostColumns.some((column) => column.name === 'jump_host_ids_json')) {
      database.exec("ALTER TABLE hosts ADD COLUMN jump_host_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hostColumns.some((column) => column.name === 'connection_profile_json')) {
      database.exec("ALTER TABLE hosts ADD COLUMN connection_profile_json TEXT NOT NULL DEFAULT '{\"keepaliveIntervalMs\":10000,\"keepaliveCountMax\":3,\"reconnect\":{\"enabled\":true,\"maxAttempts\":5,\"baseDelayMs\":250,\"maxDelayMs\":5000}}'");
    }

    const auditColumns = database.pragma('table_info(audit_events)') as Array<{ name: string }>;
    if (!auditColumns.some((column) => column.name === 'metadata_json')) {
      database.exec("ALTER TABLE audit_events ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    }

    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  });

  applyMigration();
};
