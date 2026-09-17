import { describe, expect, it } from 'vitest';

import { CloudKeyRepository } from '../../../src/cloud/key-repository.js';
import type { CloudSqlExecutor } from '../../../src/cloud/database.js';

describe('cloud key repository', () => {
  it('returns only the current device account grants and upserts bounded wrappers', async () => {
    const statements: string[] = [];
    const database: CloudSqlExecutor = {
      async query<T>(statement: string): Promise<T> {
        statements.push(statement);
        if (statement.includes('account_data_keys')) {
          return [{
            key_version: 1,
            device_id: 'device-1',
            wrapped_key_json: { scheme: 'test', ciphertext: 'wrapped' },
            created_at: '2026-09-17T00:00:00.000Z',
            revoked_at: null
          }] as T;
        }
        return [{ device_id: 'device-1' }] as T;
      },
      async execute<T>(statement: string): Promise<T> {
        statements.push(statement);
        return {} as T;
      }
    };
    const repository = new CloudKeyRepository(database);

    await expect(repository.listAccountDataKeys('account-1', 'device-1')).resolves.toEqual([expect.objectContaining({
      domain: 'account-data',
      resourceId: 'account-1',
      recipientDeviceId: 'device-1',
      wrappedKey: { scheme: 'test', ciphertext: 'wrapped' }
    })]);

    await expect(repository.putAccountDataKey({
      protocolVersion: 1,
      domain: 'account-data',
      accountId: 'account-1',
      resourceId: 'account-1',
      recipientDeviceId: 'device-1',
      keyVersion: 1,
      wrappedKey: { scheme: 'test', ciphertext: 'wrapped-2' }
    }, '2026-09-17T01:00:00.000Z')).resolves.toEqual(expect.objectContaining({
      recipientDeviceId: 'device-1',
      wrappedKey: { scheme: 'test', ciphertext: 'wrapped-2' },
      revokedAt: null
    }));
    expect(statements.some((statement) => statement.includes('ON DUPLICATE KEY UPDATE'))).toBe(true);
  });

  it('rejects a wrapper for a revoked or unknown recipient device', async () => {
    const database: CloudSqlExecutor = {
      async query<T>(): Promise<T> { return [] as T; },
      async execute<T>(): Promise<T> { return {} as T; }
    };
    const repository = new CloudKeyRepository(database);

    await expect(repository.putAccountDataKey({
      protocolVersion: 1,
      domain: 'account-data',
      accountId: 'account-1',
      resourceId: 'account-1',
      recipientDeviceId: 'device-2',
      keyVersion: 1,
      wrappedKey: { scheme: 'test', ciphertext: 'wrapped' }
    }, '2026-09-17T01:00:00.000Z')).rejects.toMatchObject({ code: 'ACCOUNT_DEVICE_REVOKED' });
  });
});
