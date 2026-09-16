import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { migrate } from '../../../src/server/db/migrations.js';
import { HostRepository, IdentityRepository } from '../../../src/server/db/repositories.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { IdentityService } from '../../../src/server/identity/identity-service.js';
import { VaultService } from '../../../src/server/vault/vault-service.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const fixture = () => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
  const repository = new IdentityRepository(database, 'owner-a');
  const service = new IdentityService({ database, vaultService: new VaultService() });
  return { database, repository, hostRepository: new HostRepository(database, 'owner-a'), service, vaultKey: Buffer.alloc(32, 7) };
};

const input = {
  name: 'Production deploy',
  type: 'password' as const,
  username: 'deploy',
  auth: { type: 'password' as const, password: 'secret-value' }
};

describe('IdentityService', () => {
  it('encrypts credentials and only returns non-secret metadata', async () => {
    const { repository, service, vaultKey } = fixture();
    const created = await service.create('owner-a', input, vaultKey);

    expect(created).toMatchObject({ name: 'Production deploy', type: 'password', username: 'deploy', usageCount: 0 });
    expect(created).not.toHaveProperty('credentialCiphertext');
    expect(repository.get(created.id)).toEqual(expect.objectContaining({ credentialCiphertext: expect.any(String) }));
    await expect(service.getCredential('owner-a', created.id, vaultKey)).resolves.toEqual(input.auth);
  });

  it('isolates owners and updates the credential used by later reads', async () => {
    const { service, vaultKey } = fixture();
    const created = await service.create('owner-a', input, vaultKey);

    await expect(service.get('owner-b', created.id)).resolves.toBeNull();
    await expect(service.update('owner-b', created.id, { name: 'Hijacked' }, vaultKey)).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
    await service.update('owner-a', created.id, { auth: { type: 'password', password: 'rotated' } }, vaultKey);
    await expect(service.getCredential('owner-a', created.id, vaultKey)).resolves.toEqual({ type: 'password', password: 'rotated' });
  });

  it('does not change identity type without rotating its encrypted credential', async () => {
    const { service, vaultKey } = fixture();
    const created = await service.create('owner-a', input, vaultKey);

    await expect(service.update('owner-a', created.id, { type: 'private_key' }, vaultKey)).rejects.toMatchObject({ code: 'HOST_VALIDATION_FAILED' });
    await expect(service.getCredential('owner-a', created.id, vaultKey)).resolves.toEqual(input.auth);

    await service.update('owner-a', created.id, {
      type: 'private_key',
      auth: { type: 'private_key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----' }
    }, vaultKey);
    await expect(service.getCredential('owner-a', created.id, vaultKey)).resolves.toEqual({ type: 'private_key', privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----' });
  });

  it('rejects deleting an identity that is still referenced', async () => {
    const { service, hostRepository, vaultKey } = fixture();
    const created = await service.create('owner-a', input, vaultKey);
    hostRepository.createHost({ id: 'host-identity', ownerId: 'owner-a', name: 'Uses identity', address: '10.0.0.9', port: 22, username: 'deploy', authType: 'password', credentialCiphertext: null, credentialVersion: 1, credentialSource: 'identity', identityId: created.id, hostKeyAlgorithm: null, hostKeyFingerprint: null, groupId: null, tags: [], isFavorite: false, lastConnectedAt: null });

    await expect(service.delete('owner-a', created.id)).rejects.toMatchObject({ code: 'IDENTITY_IN_USE' });
    await expect(service.delete('owner-b', created.id)).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
  });
});
