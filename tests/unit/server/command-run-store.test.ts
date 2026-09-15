import { afterEach, describe, expect, it } from 'vitest';

import { CommandRunRepository } from '../../../src/server/db/repositories.js';
import { migrate } from '../../../src/server/db/migrations.js';
import { openDatabase } from '../../../src/server/db/database.js';
import type { CommandRun } from '../../../src/shared/core/models.js';
import { VaultService } from '../../../src/server/vault/vault-service.js';
import { CommandRunStore } from '../../../src/server/automation/command-run-store.js';

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe('CommandRunStore', () => {
  it('removes expired persisted results as well as the in-memory snapshot', async () => {
    const database = openDatabase(':memory:');
    migrate(database);
    databases.push(database);
    const vault = await VaultService.create('correct horse battery staple');
    const repository = new CommandRunRepository(database, 'owner-a');
    let currentTime = 0;
    const store = new CommandRunStore({
      ownerId: 'owner-a',
      repository,
      vaultService: new VaultService(),
      ttlMs: 1_000,
      now: () => currentTime
    });
    const run: CommandRun = {
      id: 'run-1',
      command: 'uname -a',
      hostIds: ['host-1'],
      persistOutput: true,
      status: 'completed',
      targets: [{ hostId: 'host-1', status: 'completed', exitCode: 0, output: 'safe', outputBytes: 4 }],
      createdAt: new Date(currentTime).toISOString(),
      finishedAt: new Date(currentTime).toISOString()
    };

    await store.create(run, vault.vaultKey);
    expect(repository.getRun('run-1')).not.toBeNull();

    currentTime = 2_000;
    await expect(store.get('run-1')).resolves.toBeNull();
    expect(repository.getRun('run-1')).toBeNull();
    expect(repository.listTargets('run-1')).toEqual([]);
  });
});
