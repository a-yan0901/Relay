export const CLOUD_SCHEMA_VERSION = 2 as const;

export interface CloudSchemaExecutor {
  query(statement: string): Promise<unknown>;
}

/**
 * The cloud database is deliberately independent from the Web service's
 * SQLite database.  Keep each statement idempotent so deployment and a
 * recovery rehearsal can safely run the same migration more than once.
 */
export const CLOUD_SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS accounts (
    account_id CHAR(36) NOT NULL,
    normalized_email VARCHAR(320) NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (account_id),
    UNIQUE KEY uq_accounts_email (normalized_email)
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS devices (
    device_id CHAR(36) NOT NULL,
    account_id CHAR(36) NOT NULL,
    platform ENUM('web', 'desktop', 'android') NOT NULL,
    label VARCHAR(128) NOT NULL,
    public_key TEXT NULL,
    trusted_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL,
    last_seen_at DATETIME(3) NULL,
    revoked_at DATETIME(3) NULL,
    PRIMARY KEY (device_id),
    KEY idx_devices_account_revoked (account_id, revoked_at),
    CONSTRAINT fk_devices_account FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS device_sessions (
    token_hash CHAR(64) NOT NULL,
    account_id CHAR(36) NOT NULL,
    device_id CHAR(36) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    last_used_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    revoked_at DATETIME(3) NULL,
    PRIMARY KEY (token_hash),
    KEY idx_sessions_device_expiry (device_id, expires_at),
    CONSTRAINT fk_sessions_account FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
    CONSTRAINT fk_sessions_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS account_data_keys (
    account_id CHAR(36) NOT NULL,
    key_version INT UNSIGNED NOT NULL,
    device_id CHAR(36) NOT NULL,
    wrapped_key_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    revoked_at DATETIME(3) NULL,
    PRIMARY KEY (account_id, key_version, device_id),
    CONSTRAINT fk_account_keys_account FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
    CONSTRAINT fk_account_keys_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS account_data_heads (
    account_id CHAR(36) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    key_version INT UNSIGNED NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (account_id),
    CONSTRAINT fk_account_heads_account FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS account_data_revisions (
    account_id CHAR(36) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    parent_revision BIGINT UNSIGNED NULL,
    writer_device_id CHAR(36) NOT NULL,
    key_version INT UNSIGNED NOT NULL,
    nonce VARCHAR(256) NOT NULL,
    ciphertext MEDIUMTEXT NOT NULL,
    auth_tag VARCHAR(256) NOT NULL,
    aad VARCHAR(2048) NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    byte_length INT UNSIGNED NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (account_id, revision),
    UNIQUE KEY uq_account_data_idempotency (account_id, idempotency_key_hash),
    KEY idx_account_data_writer (writer_device_id, created_at),
    CONSTRAINT fk_account_revisions_account FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
    CONSTRAINT fk_account_revisions_device FOREIGN KEY (writer_device_id) REFERENCES devices(device_id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS workspaces (
    workspace_id CHAR(36) NOT NULL,
    account_id CHAR(36) NOT NULL,
    owner_device_id CHAR(36) NOT NULL,
    encrypted_title VARCHAR(512) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    deleted_at DATETIME(3) NULL,
    PRIMARY KEY (workspace_id),
    UNIQUE KEY uq_workspace_owner (owner_device_id),
    KEY idx_workspaces_account (account_id, deleted_at),
    CONSTRAINT fk_workspaces_account FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
    CONSTRAINT fk_workspaces_owner FOREIGN KEY (owner_device_id) REFERENCES devices(device_id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS workspace_keys (
    workspace_id CHAR(36) NOT NULL,
    key_version INT UNSIGNED NOT NULL,
    device_id CHAR(36) NOT NULL,
    wrapped_key_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    revoked_at DATETIME(3) NULL,
    PRIMARY KEY (workspace_id, key_version, device_id),
    CONSTRAINT fk_workspace_keys_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    CONSTRAINT fk_workspace_keys_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS workspace_heads (
    workspace_id CHAR(36) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    key_version INT UNSIGNED NOT NULL,
    updated_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id),
    CONSTRAINT fk_workspace_heads_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS workspace_revisions (
    workspace_id CHAR(36) NOT NULL,
    revision BIGINT UNSIGNED NOT NULL,
    parent_revision BIGINT UNSIGNED NULL,
    writer_device_id CHAR(36) NOT NULL,
    key_version INT UNSIGNED NOT NULL,
    nonce VARCHAR(256) NOT NULL,
    ciphertext MEDIUMTEXT NOT NULL,
    auth_tag VARCHAR(256) NOT NULL,
    aad VARCHAR(2048) NOT NULL,
    payload_hash CHAR(64) NOT NULL,
    byte_length INT UNSIGNED NOT NULL,
    idempotency_key_hash CHAR(64) NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (workspace_id, revision),
    UNIQUE KEY uq_workspace_data_idempotency (workspace_id, idempotency_key_hash),
    KEY idx_workspace_data_writer (writer_device_id, created_at),
    CONSTRAINT fk_workspace_revisions_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    CONSTRAINT fk_workspace_revisions_device FOREIGN KEY (writer_device_id) REFERENCES devices(device_id) ON DELETE RESTRICT
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS workspace_memberships (
    workspace_id CHAR(36) NOT NULL,
    device_id CHAR(36) NOT NULL,
    role ENUM('owner', 'member') NOT NULL,
    created_at DATETIME(3) NOT NULL,
    revoked_at DATETIME(3) NULL,
    PRIMARY KEY (workspace_id, device_id),
    CONSTRAINT fk_workspace_membership_workspace FOREIGN KEY (workspace_id) REFERENCES workspaces(workspace_id) ON DELETE CASCADE,
    CONSTRAINT fk_workspace_membership_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,
  `CREATE TABLE IF NOT EXISTS audit_events (
    event_id CHAR(36) NOT NULL,
    account_id CHAR(36) NULL,
    device_id CHAR(36) NULL,
    event_type VARCHAR(96) NOT NULL,
    metadata_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL,
    PRIMARY KEY (event_id),
    KEY idx_cloud_audit_account_time (account_id, created_at),
    CONSTRAINT fk_cloud_audit_account FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE SET NULL,
    CONSTRAINT fk_cloud_audit_device FOREIGN KEY (device_id) REFERENCES devices(device_id) ON DELETE SET NULL
  ) ENGINE=InnoDB`
] as const;

export const applyCloudSchema = async (executor: CloudSchemaExecutor): Promise<void> => {
  for (const statement of CLOUD_SCHEMA_STATEMENTS) {
    await executor.query(statement);
  }
};
