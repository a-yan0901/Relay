import { describe, expect, it } from 'vitest';

import { CloudWorkspaceRepository } from '../../../src/cloud/workspace-repository.js';
import type { CloudSqlExecutor } from '../../../src/cloud/database.js';

describe('cloud workspace repository', () => {
  it('lists only active workspaces owned by the account', async () => {
    const statements: string[] = [];
    const database: CloudSqlExecutor = {
      async query<T>(statement: string): Promise<T> {
        statements.push(statement);
        return [{
          workspace_id: 'workspace-1',
          account_id: 'account-1',
          owner_device_id: 'device-1',
          encrypted_title: 'cipher-title',
          created_at: '2026-09-17T00:00:00.000Z',
          updated_at: '2026-09-17T01:00:00.000Z',
          deleted_at: null
        }] as T;
      },
      async execute<T>(): Promise<T> {
        throw new Error('not used');
      }
    };

    const workspaces = await new CloudWorkspaceRepository(database).list('account-1');

    expect(workspaces).toEqual([{
      id: 'workspace-1',
      accountId: 'account-1',
      ownerDeviceId: 'device-1',
      encryptedTitle: 'cipher-title',
      createdAt: '2026-09-17T00:00:00.000Z',
      updatedAt: '2026-09-17T01:00:00.000Z',
      deletedAt: null
    }]);
    expect(statements[0]).toContain('deleted_at IS NULL');
  });
});
