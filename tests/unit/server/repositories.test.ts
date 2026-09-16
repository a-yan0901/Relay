import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  AppConfigRepository,
  AccountRepository,
  AuditRepository,
  GroupRepository,
  HostRepository,
  IdentityRepository,
  type HostCreateRow
} from '../../../src/server/db/repositories.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';

const databases: Database.Database[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) {
    database.close();
  }
});

const createTestDatabase = (): Database.Database => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
  return database;
};

const encryptedCredential = (value: string): string => JSON.stringify({
  version: 1,
  nonce: `nonce-${value}`,
  ciphertext: `ciphertext-${value}`,
  authTag: `tag-${value}`,
  aad: 'host:credentials:v1'
});

const hostInput = (overrides: Partial<HostCreateRow> = {}): HostCreateRow => ({
  id: 'host-1',
  ownerId: 'owner-a',
  name: 'Production API',
  address: '10.0.0.8',
  port: 22,
  username: 'deploy',
  authType: 'password',
  credentialCiphertext: encryptedCredential('a'),
  credentialVersion: 1,
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  groupId: null,
  tags: ['prod'],
  isFavorite: true,
  lastConnectedAt: null,
  ...overrides
});

describe('SQLite repositories', () => {
  it('creates the schema with foreign keys enabled', () => {
    const database = createTestDatabase();
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>;

    expect(tables.map(({ name }) => name)).toEqual(expect.arrayContaining([
      'app_config',
      'groups',
      'hosts',
      'audit_events',
      'accounts',
      'account_devices',
      'account_sessions'
    ]));
    expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('stores account credentials and owner-scoped device metadata', () => {
    const database = createTestDatabase();
    const accounts = new AccountRepository(database);
    const account = accounts.createAccount({
      id: 'account-a',
      email: 'a@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$hash'
    });
    const device = accounts.createDevice({
      id: 'device-a',
      accountId: account.id,
      label: 'Browser',
      platform: 'web'
    });

    expect(accounts.getAccountByEmail('a@example.com')).toEqual(expect.objectContaining({
      id: 'account-a',
      email: 'a@example.com',
      passwordHash: account.passwordHash
    }));
    expect(accounts.listDevices(account.id)).toEqual([expect.objectContaining({
      id: device.id,
      accountId: account.id,
      label: 'Browser',
      platform: 'web',
      revokedAt: null
    })]);
    expect(accounts.listDevices('account-b')).toEqual([]);
    expect(accounts.revokeDevice('account-b', device.id)).toBe(false);
    expect(accounts.getDevice(account.id, device.id)?.revokedAt).toBeNull();
    expect(accounts.revokeDevice(account.id, device.id)).toBe(true);
    expect(accounts.getDevice(account.id, device.id)?.revokedAt).not.toBeNull();
  });

  it('creates, restores, and expires account deletion requests without touching local owner data', () => {
    const database = createTestDatabase();
    const accounts = new AccountRepository(database);
    const account = accounts.createAccount({
      id: 'account-delete-a',
      email: 'delete-a@example.com',
      passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$hash'
    });
    const device = accounts.createDevice({ id: 'device-delete-a', accountId: account.id, label: 'Browser', platform: 'web' });
    database.prepare(`
      INSERT INTO hosts (id, owner_id, name, address, port, username, auth_type, credential_ciphertext, credential_version, created_at, updated_at)
      VALUES ('local-host', 'default', 'Local host', '10.0.0.8', 22, 'deploy', 'password', 'local-ciphertext', 1, '2026-01-01', '2026-01-01')
    `).run();
    database.prepare('INSERT INTO account_sessions (id, account_id, device_id, expires_at, last_used_at, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run('db-session', account.id, device.id, '2026-12-01', '2026-01-01', '2026-01-01');

    const requested = accounts.requestAccountDeletion(account.id, '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(requested).toEqual({ accountId: account.id, deleteAfter: '2026-02-01T00:00:00.000Z', requestedAt: '2026-01-01T00:00:00.000Z' });
    expect(accounts.getAccountDeletionRequest(account.id)).toEqual(requested);
    expect(accounts.getDevice(account.id, device.id)?.revokedAt).toBe('2026-01-01T00:00:00.000Z');

    accounts.restoreAccountDeletion(account.id, '2026-01-02T00:00:00.000Z');
    expect(accounts.getAccountDeletionRequest(account.id)).toBeNull();
    expect(accounts.getAccount(account.id)).not.toBeNull();

    accounts.requestAccountDeletion(account.id, '2026-02-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
    expect(accounts.purgeExpiredAccountDeletion(account.id, '2026-02-01T00:00:00.000Z')).toBe(true);
    expect(accounts.getAccount(account.id)).toBeNull();
    expect(database.prepare('SELECT id FROM account_devices WHERE account_id = ?').all(account.id)).toEqual([]);
    expect(database.prepare('SELECT id FROM account_sessions WHERE account_id = ?').all(account.id)).toEqual([]);
    expect(database.prepare('SELECT id, name FROM hosts WHERE id = ?').get('local-host')).toEqual({ id: 'local-host', name: 'Local host' });
    expect(accounts.purgeExpiredAccountDeletion(account.id, '2026-02-02T00:00:00.000Z')).toBe(false);
  });

  it('stores app configuration as one retrievable vault config', () => {
    const database = createTestDatabase();
    const repository = new AppConfigRepository(database);
    const vaultConfig = {
      version: 1 as const,
      kdf: {
        algorithm: 'argon2id' as const,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
        hashLength: 32,
        salt: 'c2FsdC1maXh0dXJl'
      },
      wrappedVaultKey: {
        version: 1 as const,
        nonce: 'bm9uY2U=',
        ciphertext: 'Y2lwaGVydGV4dA==',
        authTag: 'YXV0aC10YWc=',
        aad: 'dmF1bHQta2V5OnYx'
      }
    };

    const created = repository.create(vaultConfig);

    expect(created.vaultConfig).toEqual(vaultConfig);
    expect(repository.get()?.vaultConfig).toEqual(vaultConfig);
    expect(() => repository.create(vaultConfig)).toThrowError();
  });

  it('creates, filters, updates, and deletes host metadata without exposing ciphertext', () => {
    const database = createTestDatabase();
    const groups = new GroupRepository(database, 'owner-a');
    const group = groups.create({ name: 'Production', sortOrder: 1 });
    const hosts = new HostRepository(database, 'owner-a');
    const created = hosts.createHost(hostInput({ groupId: group.id }));

    expect(created.id).toBe('host-1');
    expect(hosts.listMetadata({ query: 'production', groupId: group.id, favorite: true })).toEqual([
      expect.objectContaining({
        id: 'host-1',
        name: 'Production API',
        groupId: group.id,
        tags: ['prod'],
        isFavorite: true
      })
    ]);
    expect(hosts.listMetadata({})[0]).not.toHaveProperty('credentialCiphertext');

    const updated = hosts.updateHost('host-1', {
      name: 'Production Shell',
      authType: 'private_key',
      credentialCiphertext: encryptedCredential('b'),
      tags: ['prod', 'shell'],
      isFavorite: false
    });

    expect(updated.name).toBe('Production Shell');
    expect(updated.authType).toBe('private_key');
    expect(hosts.getForConnection('host-1')).toEqual(expect.objectContaining({
      credentialCiphertext: encryptedCredential('b'),
      tags: ['prod', 'shell'],
      isFavorite: false
    }));

    const connectedAt = '2026-09-14T12:00:00.000Z';
    hosts.markConnected('host-1', connectedAt);
    expect(hosts.getForConnection('host-1')?.lastConnectedAt).toBe(connectedAt);

    hosts.setHostKey('host-1', 'ssh-ed25519', 'SHA256:fixture');
    expect(hosts.getForConnection('host-1')).toEqual(expect.objectContaining({
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyFingerprint: 'SHA256:fixture'
    }));

    hosts.deleteHost('host-1');
    expect(hosts.getForConnection('host-1')).toBeNull();
    expect(database.prepare('SELECT * FROM hosts WHERE id = ?').get('host-1')).toBeUndefined();
  });

  it('enforces exactly one host credential source at the repository boundary', () => {
    const database = createTestDatabase();
    const groups = new GroupRepository(database, 'owner-a');
    const group = groups.create({ name: 'Production' });
    const identities = new IdentityRepository(database, 'owner-a');
    identities.create({
      ownerId: 'owner-a', id: 'identity-1', name: 'Operations', type: 'password', username: 'deploy',
      keyFingerprint: null, credentialCiphertext: 'encrypted', credentialVersion: 1, createdAt: '', updatedAt: ''
    });
    const hosts = new HostRepository(database, 'owner-a');

    expect(() => hosts.createHost(hostInput({ credentialSource: 'group', groupId: group.id, identityId: 'identity-1', credentialCiphertext: null }))).toThrowError();
    const created = hosts.createHost(hostInput());
    expect(() => hosts.updateHost(created.id, {
      credentialSource: 'identity',
      identityId: 'identity-1'
    })).toThrowError();
    expect(() => hosts.updateHost(created.id, {
      credentialSource: 'group',
      groupId: group.id,
      identityId: 'identity-1',
      credentialCiphertext: null
    })).toThrowError();
  });

  it('persists non-secret connection profile settings with defaults for legacy rows', () => {
    const database = createTestDatabase();
    const hosts = new HostRepository(database, 'owner-a');
    const profile = {
      keepaliveIntervalMs: 12_000,
      keepaliveCountMax: 7,
      reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 300, maxDelayMs: 2_000 }
    };
    const created = hosts.createHost(hostInput({ connectionProfile: profile }));

    expect(created.connectionProfile).toEqual(profile);
    expect(hosts.listMetadata()[0]?.connectionProfile).toEqual(profile);
    const updated = hosts.updateHost('host-1', { connectionProfile: { ...profile, reconnect: { ...profile.reconnect, maxAttempts: 4 } } });
    expect(updated.connectionProfile?.reconnect.maxAttempts).toBe(4);
  });

  it('isolates host and group queries by owner', () => {
    const database = createTestDatabase();
    const ownerAHosts = new HostRepository(database, 'owner-a');
    const ownerBHosts = new HostRepository(database, 'owner-b');
    const ownerAGroups = new GroupRepository(database, 'owner-a');
    const ownerBGroups = new GroupRepository(database, 'owner-b');
    const ownerBAudit = new AuditRepository(database, 'owner-b');

    ownerAGroups.create({ name: 'Private Group' });
    ownerAHosts.createHost(hostInput());

    expect(ownerBHosts.listMetadata({})).toEqual([]);
    expect(ownerBHosts.getForConnection('host-1')).toBeNull();
    expect(ownerBGroups.list()).toEqual([]);
    expect(() => ownerBHosts.updateHost('host-1', { name: 'Hijacked' })).toThrowError();
    expect(() => ownerBHosts.deleteHost('host-1')).toThrowError();
    expect(() => ownerBAudit.insert({ eventType: 'host_created', hostId: 'host-1', requestId: 'req-cross-owner' }))
      .toThrowError();
  });

  it('reassigns hosts to null when a group is deleted and records audit events', () => {
    const database = createTestDatabase();
    const groups = new GroupRepository(database, 'owner-a');
    const hosts = new HostRepository(database, 'owner-a');
    const audit = new AuditRepository(database, 'owner-a');
    const group = groups.create({ name: 'Temporary' });
    hosts.createHost(hostInput({ groupId: group.id }));

    groups.delete(group.id);
    expect(hosts.getForConnection('host-1')?.groupId).toBeNull();

    audit.insert({
      eventType: 'host_created',
      hostId: 'host-1',
      requestId: 'req-1',
      remoteAddress: '127.0.0.1'
    });
    const events = audit.listRecent(10);
    expect(events).toEqual([expect.objectContaining({
      ownerId: 'owner-a',
      eventType: 'host_created',
      hostId: 'host-1',
      requestId: 'req-1'
    })]);
  });
});
