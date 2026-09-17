import { describe, expect, it } from 'vitest';

import {
  CLOUD_SCHEMA_VERSION,
  CLOUD_SCHEMA_STATEMENTS,
  applyCloudSchema
} from '../../../src/cloud/schema.js';

describe('cloud MySQL schema', () => {
  it('contains the account sync and live workspace tables in dependency order', () => {
    expect(CLOUD_SCHEMA_VERSION).toBe(2);
    const sql = CLOUD_SCHEMA_STATEMENTS.join('\n');
    for (const table of [
      'accounts',
      'devices',
      'device_sessions',
      'account_data_keys',
      'account_data_heads',
      'account_data_revisions',
      'workspaces',
      'workspace_keys',
      'workspace_heads',
      'workspace_revisions',
      'workspace_memberships',
      'audit_events'
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    expect(CLOUD_SCHEMA_STATEMENTS.findIndex((statement) => statement.includes('CREATE TABLE IF NOT EXISTS accounts')))
      .toBeLessThan(CLOUD_SCHEMA_STATEMENTS.findIndex((statement) => statement.includes('CREATE TABLE IF NOT EXISTS devices')));
    expect(sql).toContain('UNIQUE KEY uq_account_data_idempotency');
    expect(sql).toContain('UNIQUE KEY uq_workspace_data_idempotency');
    expect(sql).toContain('FOREIGN KEY (account_id) REFERENCES accounts(account_id)');
  });

  it('executes each migration statement once and preserves order', async () => {
    const executed: string[] = [];
    await applyCloudSchema({
      async query(statement: string) {
        executed.push(statement);
      }
    });
    expect(executed).toEqual(CLOUD_SCHEMA_STATEMENTS);
  });
});
