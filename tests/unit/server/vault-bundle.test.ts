import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { migrate } from '../../../src/server/db/migrations.js';
import { GroupRepository, HostRepository } from '../../../src/server/db/repositories.js';
import { VaultService } from '../../../src/server/vault/vault-service.js';
import { VaultBundleService } from '../../../src/server/workspace/vault-bundle-service.js';
import type { EncryptedJson } from '../../../src/server/vault/types.js';

const EXPORT_PASSWORD = 'bundle-export-password';
const HOST_PASSWORD = 'host-password-never-plain-in-bundle';

interface Fixture {
  database: Database.Database;
  sessionKey: Buffer;
  hosts: HostRepository;
  service: VaultBundleService;
}

const createFixture = async (withHost = true): Promise<Fixture> => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  migrate(database);
  const created = await VaultService.create('correct horse battery staple');
  const hosts = new HostRepository(database, 'default');
  const groups = new GroupRepository(database, 'default');
  if (withHost) {
    const group = groups.create({ id: 'group-1', name: 'Production' });
    const encrypted = await VaultService.encryptJson(created.vaultKey, 'host:host-1:credentials:v1', { type: 'password', password: HOST_PASSWORD });
    hosts.createHost({
      id: 'host-1', ownerId: 'default', name: 'Production', address: '10.0.0.8', port: 22, username: 'ops',
      authType: 'password', credentialCiphertext: JSON.stringify(encrypted), credentialVersion: 1,
      hostKeyAlgorithm: null, hostKeyFingerprint: null, groupId: group.id, tags: ['prod'], isFavorite: true, lastConnectedAt: null
    });
  }
  return { database, sessionKey: created.vaultKey, hosts, service: new VaultBundleService({
    ownerId: 'default', database, hostRepository: hosts, groupRepository: groups, vaultService: new VaultService()
  }) };
};

describe('VaultBundleService', () => {
  it('exports an encrypted bundle and imports it after a preview', async () => {
    const source = await createFixture();
    const target = await createFixture(false);
    const bundle = await source.service.export(source.sessionKey, EXPORT_PASSWORD);
    expect(bundle).not.toContain(HOST_PASSWORD);
    const preview = await target.service.previewImport(target.sessionKey, EXPORT_PASSWORD, bundle);
    expect(preview).toEqual(expect.objectContaining({ hostCount: 1, groupCount: 1, conflicts: [] }));
    const result = await target.service.applyImport(target.sessionKey, preview.previewId, { hostConflicts: 'skip', groupConflicts: 'reuse' });
    expect(result).toEqual(expect.objectContaining({ importedHosts: 1, importedGroups: 1 }));
    expect(target.hosts.getForConnection('host-1')).toEqual(expect.objectContaining({ name: 'Production' }));
    source.database.close();
    target.database.close();
  });
  it('rejects wrong passwords, tampered ciphertext and unsupported versions', async () => {
    const source = await createFixture();
    const bundle = await source.service.export(source.sessionKey, EXPORT_PASSWORD);
    const target = await createFixture(false);
    await expect(target.service.previewImport(target.sessionKey, 'wrong-password', bundle)).rejects.toMatchObject({ code: 'VAULT_BUNDLE_INVALID' });
    const tampered = JSON.parse(bundle) as { payload: EncryptedJson };
    const ciphertext = Buffer.from(tampered.payload.ciphertext, 'base64');
    ciphertext[0] ^= 1;
    tampered.payload.ciphertext = ciphertext.toString('base64');
    await expect(target.service.previewImport(target.sessionKey, EXPORT_PASSWORD, JSON.stringify(tampered))).rejects.toMatchObject({ code: 'VAULT_BUNDLE_INVALID' });
    const unsupported = JSON.parse(bundle) as { version: number };
    unsupported.version = 999;
    await expect(target.service.previewImport(target.sessionKey, EXPORT_PASSWORD, JSON.stringify(unsupported))).rejects.toMatchObject({ code: 'VAULT_BUNDLE_INVALID' });
    source.database.close();
    target.database.close();
  });
  it('reports conflicts and leaves existing hosts unchanged when applying invalid input', async () => {
    const fixture = await createFixture();
    const bundle = await fixture.service.export(fixture.sessionKey, EXPORT_PASSWORD);
    const preview = await fixture.service.previewImport(fixture.sessionKey, EXPORT_PASSWORD, bundle);
    expect(preview.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'host-1', type: 'host' })]));
    const before = fixture.hosts.getForConnection('host-1');
    await expect(fixture.service.applyImport(fixture.sessionKey, preview.previewId, { hostConflicts: 'invalid' as 'skip', groupConflicts: 'reuse' })).rejects.toMatchObject({ code: 'VAULT_BUNDLE_INVALID' });
    expect(fixture.hosts.getForConnection('host-1')).toEqual(before);
    fixture.database.close();
  });

  it('rejects an imported jump-host cycle before changing the target vault', async () => {
    const source = await createFixture();
    source.database.prepare('UPDATE hosts SET jump_host_ids_json = ? WHERE id = ?').run('["host-1"]', 'host-1');
    const target = await createFixture(false);
    const bundle = await source.service.export(source.sessionKey, EXPORT_PASSWORD);
    const preview = await target.service.previewImport(target.sessionKey, EXPORT_PASSWORD, bundle);

    await expect(target.service.applyImport(target.sessionKey, preview.previewId, { hostConflicts: 'skip', groupConflicts: 'reuse' })).rejects.toMatchObject({ code: 'HOST_VALIDATION_FAILED' });
    expect(target.hosts.getForConnection('host-1')).toBeNull();
    source.database.close();
    target.database.close();
  });
});
