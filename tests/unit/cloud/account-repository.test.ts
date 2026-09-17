import { describe, expect, it } from 'vitest';

import { CloudAccountRepository } from '../../../src/cloud/account-repository.js';
import type { CloudSqlExecutor } from '../../../src/cloud/database.js';

describe('cloud account repository', () => {
  it('maps only active devices for an account', async () => {
    const queries: string[] = [];
    const database: CloudSqlExecutor = {
      async query<T>(statement: string): Promise<T> {
        queries.push(statement);
        return [
          {
            device_id: 'device-1',
            account_id: 'account-1',
            platform: 'web',
            label: 'Browser',
            created_at: '2026-09-17T00:00:00.000Z',
            last_seen_at: '2026-09-17T01:00:00.000Z',
            revoked_at: null
          },
          {
            device_id: 'device-2',
            account_id: 'account-1',
            platform: 'android',
            label: 'Phone',
            created_at: '2026-09-17T00:00:00.000Z',
            last_seen_at: null,
            revoked_at: '2026-09-17T02:00:00.000Z'
          }
        ] as T;
      },
      async execute<T>(): Promise<T> {
        throw new Error('not used');
      }
    };

    const devices = await new CloudAccountRepository(database).listDevices('account-1');

    expect(devices).toEqual([{
      id: 'device-1',
      accountId: 'account-1',
      label: 'Browser',
      platform: 'web',
      createdAt: '2026-09-17T00:00:00.000Z',
      lastSeenAt: '2026-09-17T01:00:00.000Z',
      revokedAt: null
    }]);
    expect(queries[0]).toContain('revoked_at IS NULL');
  });
});
