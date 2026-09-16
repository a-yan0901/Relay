import { afterEach, describe, expect, it } from 'vitest';

import { TransferRepository } from '../../../src/server/db/repositories.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';
import { TransferManager } from '../../../src/server/sftp/transfer-manager.js';
import type { SftpResource } from '../../../src/server/sftp/types.js';

const databases: ReturnType<typeof openDatabase>[] = [];

const hostRow = {
  id: 'host-1', owner_id: 'owner-a', name: 'Host', address: '127.0.0.1', port: 22, username: 'ops', auth_type: 'password',
  credential_ciphertext: null, credential_version: 1, credential_source: 'inline', identity_id: null, host_key_algorithm: null,
  host_key_fingerprint: null, group_id: null, tags_json: '[]', jump_host_ids_json: '[]',
  connection_profile_json: '{"keepaliveIntervalMs":10000,"keepaliveCountMax":3,"reconnect":{"enabled":true,"maxAttempts":5,"baseDelayMs":250,"maxDelayMs":5000}}',
  connection_profile_overrides_json: null, is_favorite: 0, last_connected_at: null, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString()
};

const resource = (): SftpResource => ({
  async list() { return []; }, async stat() { return null; }, async mkdir() {}, async rename() {}, async remove() {}, async rmdir() {},
  async writeFile() {}, async readFile() { return (async function* () {})(); }, close() {}
});

describe('transfer restart persistence', () => {
  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('marks active transfers interrupted and makes them retryable after restart', async () => {
    const database = openDatabase(':memory:');
    migrate(database);
    databases.push(database);
    database.prepare(`
      INSERT INTO hosts (id, owner_id, name, address, port, username, auth_type, credential_ciphertext, credential_version, credential_source, identity_id, host_key_algorithm, host_key_fingerprint, group_id, tags_json, jump_host_ids_json, connection_profile_json, connection_profile_overrides_json, is_favorite, last_connected_at, created_at, updated_at)
      VALUES (@id, @owner_id, @name, @address, @port, @username, @auth_type, @credential_ciphertext, @credential_version, @credential_source, @identity_id, @host_key_algorithm, @host_key_fingerprint, @group_id, @tags_json, @jump_host_ids_json, @connection_profile_json, @connection_profile_overrides_json, @is_favorite, @last_connected_at, @created_at, @updated_at)
    `).run(hostRow);
    const repository = new TransferRepository(database, 'owner-a');
    repository.create({
      ownerId: 'owner-a',
      id: 'transfer-restart',
      kind: 'download',
      hostId: 'host-1',
      sourcePath: '/remote.txt',
      targetPath: 'remote.txt',
      status: 'running',
      completedBytes: 4,
      totalBytes: 10,
      checkpointOffset: 4,
      checkpointChecksum: 'a'.repeat(64),
      temporaryPath: null,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString()
    });

    const manager = new TransferManager({ ownerId: 'owner-a', repository, resourceProvider: { open: async () => ({ resource: resource(), close() {} }) }, now: () => 1_000 });
    expect(await manager.get('transfer-restart')).toMatchObject({ status: 'interrupted', errorCode: 'SERVICE_RESTARTED', completedBytes: 4, checkpoint: { offset: 4, checksum: 'a'.repeat(64) } });
    expect((await manager.retry('transfer-restart')).status).toBe('queued');
    expect((await manager.get('transfer-restart'))?.checkpoint?.offset).toBe(4);
    expect((await manager.get('transfer-restart'))?.completedBytes).toBe(4);
    expect(repository.get('transfer-restart')?.status).toBe('queued');
  });
});
