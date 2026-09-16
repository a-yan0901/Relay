import type { SqliteDatabase } from './database.js';

const SCHEMA_VERSION = 10;

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
        parent_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        default_identity_id TEXT REFERENCES identities(id) ON DELETE RESTRICT,
        connection_profile_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (owner_id, name)
      );

      CREATE TABLE IF NOT EXISTS identities (
        id TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL DEFAULT 'default',
        name TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('password', 'private_key')),
        username TEXT NOT NULL,
        key_fingerprint TEXT,
        credential_ciphertext TEXT NOT NULL,
        credential_version INTEGER NOT NULL DEFAULT 1,
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
        credential_ciphertext TEXT,
        credential_version INTEGER NOT NULL DEFAULT 1,
        credential_source TEXT NOT NULL DEFAULT 'inline' CHECK (credential_source IN ('inline', 'identity', 'group')),
        identity_id TEXT REFERENCES identities(id) ON DELETE RESTRICT,
        host_key_algorithm TEXT,
        host_key_fingerprint TEXT,
        group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
        tags_json TEXT NOT NULL DEFAULT '[]',
        jump_host_ids_json TEXT NOT NULL DEFAULT '[]',
        connection_profile_json TEXT NOT NULL DEFAULT '{"keepaliveIntervalMs":10000,"keepaliveCountMax":3,"reconnect":{"enabled":true,"maxAttempts":5,"baseDelayMs":250,"maxDelayMs":5000}}',
        connection_profile_overrides_json TEXT,
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
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
        persist_output INTEGER NOT NULL DEFAULT 0 CHECK (persist_output IN (0, 1)),
        created_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE IF NOT EXISTS command_run_targets (
        run_id TEXT NOT NULL,
        owner_id TEXT NOT NULL DEFAULT 'default',
        host_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
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
      CREATE INDEX IF NOT EXISTS idx_identities_owner_name
        ON identities (owner_id, name COLLATE NOCASE);
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

      CREATE TABLE IF NOT EXISTS transfer_jobs (
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

      CREATE INDEX IF NOT EXISTS idx_transfer_jobs_owner_updated
        ON transfer_jobs (owner_id, updated_at DESC);
    `);

    const commandRunsSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'command_runs'").get() as { sql?: string } | undefined;
    if (commandRunsSql?.sql && !commandRunsSql.sql.includes("'interrupted'")) {
      database.exec(`
        DROP INDEX IF EXISTS idx_command_run_targets_owner_run;
        DROP INDEX IF EXISTS idx_command_runs_owner_created;
        CREATE TABLE command_runs_v9 (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT 'default',
          command_ciphertext TEXT NOT NULL,
          host_ids_json TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
          persist_output INTEGER NOT NULL DEFAULT 0 CHECK (persist_output IN (0, 1)),
          created_at TEXT NOT NULL,
          finished_at TEXT
        );
        CREATE TABLE command_run_targets_v9 (
          run_id TEXT NOT NULL,
          owner_id TEXT NOT NULL DEFAULT 'default',
          host_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'interrupted')),
          exit_code INTEGER,
          output_ciphertext TEXT,
          output_bytes INTEGER NOT NULL DEFAULT 0,
          output_truncated INTEGER NOT NULL DEFAULT 0 CHECK (output_truncated IN (0, 1)),
          error_code TEXT,
          started_at TEXT,
          finished_at TEXT,
          PRIMARY KEY (run_id, host_id),
          FOREIGN KEY (run_id) REFERENCES command_runs_v9(id) ON DELETE CASCADE
        );
        INSERT INTO command_runs_v9 (id, owner_id, command_ciphertext, host_ids_json, status, persist_output, created_at, finished_at)
          SELECT id, owner_id, command_ciphertext, host_ids_json, status, persist_output, created_at, finished_at FROM command_runs;
        INSERT INTO command_run_targets_v9 (run_id, owner_id, host_id, status, exit_code, output_ciphertext, output_bytes, output_truncated, error_code, started_at, finished_at)
          SELECT run_id, owner_id, host_id, status, exit_code, output_ciphertext, output_bytes, output_truncated, error_code, started_at, finished_at FROM command_run_targets;
        DROP TABLE command_run_targets;
        DROP TABLE command_runs;
        ALTER TABLE command_runs_v9 RENAME TO command_runs;
        ALTER TABLE command_run_targets_v9 RENAME TO command_run_targets;
        CREATE INDEX idx_command_runs_owner_created ON command_runs (owner_id, created_at DESC);
        CREATE INDEX idx_command_run_targets_owner_run ON command_run_targets (owner_id, run_id);
      `);
    }

    const hostColumns = database.pragma('table_info(hosts)') as Array<{ name: string }>;
    const groupColumns = database.pragma('table_info(groups)') as Array<{ name: string }>;
    if (!groupColumns.some((column) => column.name === 'parent_id')) {
      database.exec('ALTER TABLE groups ADD COLUMN parent_id TEXT REFERENCES groups(id) ON DELETE SET NULL');
    }
    if (!groupColumns.some((column) => column.name === 'default_identity_id')) {
      database.exec('ALTER TABLE groups ADD COLUMN default_identity_id TEXT REFERENCES identities(id) ON DELETE RESTRICT');
    }
    if (!groupColumns.some((column) => column.name === 'connection_profile_json')) {
      database.exec('ALTER TABLE groups ADD COLUMN connection_profile_json TEXT');
    }
    if (!hostColumns.some((column) => column.name === 'jump_host_ids_json')) {
      database.exec("ALTER TABLE hosts ADD COLUMN jump_host_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!hostColumns.some((column) => column.name === 'connection_profile_json')) {
      database.exec("ALTER TABLE hosts ADD COLUMN connection_profile_json TEXT NOT NULL DEFAULT '{\"keepaliveIntervalMs\":10000,\"keepaliveCountMax\":3,\"reconnect\":{\"enabled\":true,\"maxAttempts\":5,\"baseDelayMs\":250,\"maxDelayMs\":5000}}'");
    }
    if (!hostColumns.some((column) => column.name === 'credential_source')) {
      database.exec("ALTER TABLE hosts ADD COLUMN credential_source TEXT NOT NULL DEFAULT 'inline'");
    }
    if (!hostColumns.some((column) => column.name === 'identity_id')) {
      database.exec('ALTER TABLE hosts ADD COLUMN identity_id TEXT');
    }
    const hadConnectionProfileOverrides = hostColumns.some((column) => column.name === 'connection_profile_overrides_json');
    if (!hadConnectionProfileOverrides) {
      database.exec('ALTER TABLE hosts ADD COLUMN connection_profile_overrides_json TEXT');
      // Before host overrides existed, connection_profile_json was the user's
      // explicit host profile. Preserve it as a full override so adding group
      // inheritance does not silently replace legacy settings with defaults.
      database.exec('UPDATE hosts SET connection_profile_overrides_json = connection_profile_json WHERE connection_profile_overrides_json IS NULL');
    }

    const hostTableSql = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'hosts'").get() as { sql?: string } | undefined;
    if (hostTableSql?.sql && !hostTableSql.sql.includes("'group'")) {
      database.exec(`
        CREATE TABLE hosts_v9 (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL DEFAULT 'default',
          name TEXT NOT NULL,
          address TEXT NOT NULL,
          port INTEGER NOT NULL DEFAULT 22 CHECK (port BETWEEN 1 AND 65535),
          username TEXT NOT NULL,
          auth_type TEXT NOT NULL CHECK (auth_type IN ('password', 'private_key')),
          credential_ciphertext TEXT,
          credential_version INTEGER NOT NULL DEFAULT 1,
          credential_source TEXT NOT NULL DEFAULT 'inline' CHECK (credential_source IN ('inline', 'identity', 'group')),
          identity_id TEXT REFERENCES identities(id) ON DELETE RESTRICT,
          host_key_algorithm TEXT,
          host_key_fingerprint TEXT,
          group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
          tags_json TEXT NOT NULL DEFAULT '[]',
          jump_host_ids_json TEXT NOT NULL DEFAULT '[]',
          connection_profile_json TEXT NOT NULL DEFAULT '{"keepaliveIntervalMs":10000,"keepaliveCountMax":3,"reconnect":{"enabled":true,"maxAttempts":5,"baseDelayMs":250,"maxDelayMs":5000}}',
          connection_profile_overrides_json TEXT,
          is_favorite INTEGER NOT NULL DEFAULT 0 CHECK (is_favorite IN (0, 1)),
          last_connected_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO hosts_v9 (
          id, owner_id, name, address, port, username, auth_type,
          credential_ciphertext, credential_version, credential_source, identity_id,
          host_key_algorithm, host_key_fingerprint, group_id, tags_json,
          jump_host_ids_json, connection_profile_json, connection_profile_overrides_json,
          is_favorite, last_connected_at, created_at, updated_at
        ) SELECT
          id, owner_id, name, address, port, username, auth_type,
          credential_ciphertext, credential_version, credential_source, identity_id,
          host_key_algorithm, host_key_fingerprint, group_id, tags_json,
          jump_host_ids_json, connection_profile_json, connection_profile_overrides_json,
          is_favorite, last_connected_at, created_at, updated_at
        FROM hosts;
        DROP TABLE hosts;
        ALTER TABLE hosts_v9 RENAME TO hosts;
        CREATE INDEX IF NOT EXISTS idx_hosts_owner_name ON hosts (owner_id, name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_hosts_owner_address ON hosts (owner_id, address COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS idx_hosts_owner_recent ON hosts (owner_id, last_connected_at DESC);
        CREATE INDEX IF NOT EXISTS idx_hosts_owner_group ON hosts (owner_id, group_id);
        CREATE INDEX IF NOT EXISTS idx_hosts_owner_identity ON hosts (owner_id, identity_id);
      `);
    }
    database.exec('CREATE INDEX IF NOT EXISTS idx_hosts_owner_identity ON hosts (owner_id, identity_id)');

    const auditColumns = database.pragma('table_info(audit_events)') as Array<{ name: string }>;
    if (!auditColumns.some((column) => column.name === 'metadata_json')) {
      database.exec("ALTER TABLE audit_events ADD COLUMN metadata_json TEXT NOT NULL DEFAULT '{}'");
    }

    const transferColumns = database.pragma('table_info(transfer_jobs)') as Array<{ name: string }>;
    if (!transferColumns.some((column) => column.name === 'checkpoint_offset')) {
      database.exec('ALTER TABLE transfer_jobs ADD COLUMN checkpoint_offset INTEGER NOT NULL DEFAULT 0 CHECK (checkpoint_offset >= 0)');
    }
    if (!transferColumns.some((column) => column.name === 'checkpoint_checksum')) {
      database.exec('ALTER TABLE transfer_jobs ADD COLUMN checkpoint_checksum TEXT');
    }
    if (!transferColumns.some((column) => column.name === 'temporary_path')) {
      database.exec('ALTER TABLE transfer_jobs ADD COLUMN temporary_path TEXT');
    }

    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  });

  const foreignKeysEnabled = database.pragma('foreign_keys', { simple: true }) === 1;
  if (foreignKeysEnabled) database.pragma('foreign_keys = OFF');
  try {
    applyMigration();
  } finally {
    if (foreignKeysEnabled) database.pragma('foreign_keys = ON');
  }
};
