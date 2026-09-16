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
  it('marks persisted queued work as interrupted after a service restart and restores it after unlock', async () => {
    const database = openDatabase(':memory:');
    migrate(database);
    databases.push(database);
    const vault = await VaultService.create('correct horse battery staple');
    const repository = new CommandRunRepository(database, 'owner-a');
    const run: CommandRun = {
      id: 'run-restart',
      command: 'uname -a',
      hostIds: ['host-1'],
      persistOutput: false,
      status: 'queued',
      targets: [{ hostId: 'host-1', status: 'queued', exitCode: null, output: '', outputBytes: 0 }],
      createdAt: new Date(0).toISOString()
    };
    const firstStore = new CommandRunStore({ ownerId: 'owner-a', repository, vaultService: new VaultService(), now: () => 0 });
    await firstStore.create(run, vault.vaultKey);

    const restartedStore = new CommandRunStore({ ownerId: 'owner-a', repository, vaultService: new VaultService(), now: () => 1_000 });
    const restored = await restartedStore.get(run.id, vault.vaultKey);

    expect(restored).toMatchObject({ id: run.id, status: 'interrupted', finishedAt: new Date(1_000).toISOString() });
    expect(restored?.targets).toEqual([expect.objectContaining({ hostId: 'host-1', status: 'interrupted', errorCode: 'SERVICE_RESTARTED' })]);
  });

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
