import { randomBytes } from 'node:crypto';

import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/server/app.js';
import { AppError } from '../../../src/shared/errors.js';
import { ARGON2ID_PARAMS } from '../../../src/server/vault/types.js';
import { encryptBytes } from '../../../src/server/vault/crypto.js';
import { VaultService } from '../../../src/server/vault/vault-service.js';
import { AccountRepository, GroupRepository, HostRepository, IdentityRepository, SnippetRepository } from '../../../src/server/db/repositories.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';
import { createSyncKey, decryptSyncPayload, encryptSyncPayload, unwrapSyncKey, wrapSyncKey } from '../../../src/server/sync/sync-crypto.js';
import { BlindSyncRepository } from '../../../src/server/sync/sync-repository.js';
import { SyncSnapshotService } from '../../../src/server/sync/sync-snapshot.js';
import { SyncService } from '../../../src/server/sync/sync-service.js';
import { SnippetService } from '../../../src/server/automation/snippet-service.js';
import { VaultBundleService } from '../../../src/server/workspace/vault-bundle-service.js';
import { WorkspaceRepository } from '../../../src/server/workspace/workspace-repository.js';
import { WorkspaceService } from '../../../src/server/workspace/workspace-service.js';

const databases: ReturnType<typeof openDatabase>[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const database of databases.splice(0)) database.close();
});

const createDatabase = () => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
  return database;
};

const makeApp = async () => {
  const database = createDatabase();
  const app = await buildApp({
    database,
    config: {
      nodeEnv: 'test',
      port: 3000,
      dataDir: ':memory:',
      trustedOrigins: ['http://localhost:4173'],
      sessionIdleTimeoutMs: 60_000,
      maxSessions: 4,
      accountSyncEnabled: true,
      logLevel: 'silent'
    }
  });
  apps.push(app);
  return app;
};

const cookieFrom = (response: { headers: Record<string, string | string[] | undefined> }, name: string): string => {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`expected ${name} cookie`);
  return cookie.split(';', 1)[0];
};

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

const descriptorFor = (vaultKey: Buffer, vaultId = 'vault-1', keyVersion = 1) => ({
  vaultId,
  keyVersion,
  vaultUnlockEnvelope: {
    version: 1 as const,
    kdf: { ...ARGON2ID_PARAMS, salt: Buffer.alloc(16, 7).toString('base64') },
    wrappedVaultKey: encryptBytes(vaultKey, `vault:${vaultId}:unlock`, randomBytes(32))
  },
  wrappedSyncKey: wrapSyncKey(vaultKey, vaultId, keyVersion, createSyncKey())
});

const expectAppError = (action: () => unknown, code: string): void => {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
};

describe('blind sync storage and snapshot bridge', () => {
  it('is idempotent, enforces parent revisions, and isolates accounts', () => {
    const database = createDatabase();
    const accounts = new AccountRepository(database);
    const accountA = accounts.createAccount({ id: 'account-a', email: 'a@example.com', passwordHash: 'hashhashhashhash' });
    const deviceA = accounts.createDevice({ id: 'device-a', accountId: accountA.id, label: 'Web', platform: 'web' });
    const accountB = accounts.createAccount({ id: 'account-b', email: 'b@example.com', passwordHash: 'hashhashhashhash' });
    accounts.createDevice({ id: 'device-b', accountId: accountB.id, label: 'Web', platform: 'web' });
    const vaultKey = randomBytes(32);
    const syncKey = createSyncKey();
    const store = new BlindSyncRepository(database);
    store.saveDescriptor(accountA.id, descriptorFor(vaultKey));

    const first = encryptSyncPayload({
      syncKey,
      vaultId: 'vault-1',
      revision: 1,
      parentRevision: null,
      deviceId: deviceA.id,
      keyVersion: 1,
      plaintext: Buffer.from('encrypted snapshot')
    });
    const firstHead = store.putEnvelope(accountA.id, first, 'request-1');
    expect(store.putEnvelope(accountA.id, first, 'request-1')).toEqual(firstHead);
    expect(store.getEnvelope(accountA.id)).toEqual(first);

    const wrongParent = encryptSyncPayload({
      syncKey,
      vaultId: 'vault-1',
      revision: 2,
      parentRevision: 0,
      deviceId: deviceA.id,
      keyVersion: 1,
      plaintext: Buffer.from('new snapshot')
    });
    expectAppError(() => store.putEnvelope(accountA.id, wrongParent, 'request-2'), 'SYNC_CONFLICT');
    expect(store.getEnvelope(accountA.id)).toEqual(first);
    expect(store.getDescriptor(accountB.id)).toBeNull();
    expect(store.getEnvelope(accountB.id)).toBeNull();
    expectAppError(() => store.putEnvelope(accountB.id, first, 'request-b'), 'SYNC_NOT_FOUND');

    const conflictId = store.saveConflict(accountA.id, first, encryptSyncPayload({
      syncKey,
      vaultId: 'vault-1',
      revision: 2,
      parentRevision: 1,
      deviceId: deviceA.id,
      keyVersion: 1,
      plaintext: Buffer.from('remote snapshot')
    }));
    expect(store.getConflict(accountA.id, conflictId)).not.toBeNull();
    expect(store.getConflict(accountB.id, conflictId)).toBeNull();
  });

  it('stores only opaque descriptor/envelope columns and never plaintext sync material', () => {
    const database = createDatabase();
    const accounts = new AccountRepository(database);
    const account = accounts.createAccount({ id: 'account-a', email: 'a@example.com', passwordHash: 'hashhashhashhash' });
    const device = accounts.createDevice({ id: 'device-a', accountId: account.id, label: 'Web', platform: 'web' });
    const vaultKey = randomBytes(32);
    const syncKey = createSyncKey();
    const descriptor = descriptorFor(vaultKey);
    const store = new BlindSyncRepository(database);
    store.saveDescriptor(account.id, descriptor);
    const envelope = encryptSyncPayload({
      syncKey,
      vaultId: descriptor.vaultId,
      revision: 1,
      parentRevision: null,
      deviceId: device.id,
      keyVersion: 1,
      plaintext: Buffer.from(JSON.stringify({ password: 'plaintext-secret' }))
    });
    store.putEnvelope(account.id, envelope, 'request-1');

    expect(JSON.stringify(store.getDescriptor(account.id))).not.toContain(syncKey.toString('base64'));
    expect(JSON.stringify(store.getDescriptor(account.id))).not.toContain('vaultKey');
    const columns = database.prepare('PRAGMA table_info(sync_envelopes)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining(['email', 'address', 'password', 'private_key']));
    const persisted = database.prepare('SELECT * FROM sync_envelopes').get() as Record<string, unknown>;
    expect(JSON.stringify(persisted)).not.toContain('plaintext-secret');
  });

  it('serializes only syncable resources and rolls back all snapshot writes on apply failure', async () => {
    const database = createDatabase();
    const ownerId = 'owner-a';
    const vaultKey = randomBytes(32);
    const vaultService = new VaultService();
    const hostRepository = new HostRepository(database, ownerId);
    const groupRepository = new GroupRepository(database, ownerId);
    const identityRepository = new IdentityRepository(database, ownerId);
    const credential = await vaultService.encryptJson(vaultKey, 'host:host-1:credentials:v1', { type: 'password', password: 'host-secret' });
    hostRepository.createHost({
      id: 'host-1', ownerId, name: 'Production', address: '10.0.0.8', port: 22, username: 'deploy', authType: 'password',
      credentialCiphertext: JSON.stringify(credential), credentialVersion: 1, hostKeyAlgorithm: 'ssh-ed25519', hostKeyFingerprint: 'SHA256:stable',
      groupId: null, tags: ['prod'], isFavorite: true, lastConnectedAt: null
    });
    const workspaceRepository = new WorkspaceRepository(database);
    const workspaceService = new WorkspaceService(workspaceRepository);
    workspaceService.save(ownerId, 0, {
      version: 0,
      tabs: [{ id: 'tab-1', hostId: 'host-1', title: 'Production' }],
      activeTabId: 'tab-1',
      layout: { mode: 'single', ratio: 0.5 },
      filters: { query: '', groupId: null, favoriteOnly: false }
    });
    const snippetRepository = new SnippetRepository(database, ownerId);
    const snippetService = new SnippetService({ ownerId, repository: snippetRepository, vaultService });
    await snippetService.create({ name: 'Health', command: 'echo ok', tags: [], variables: [] }, vaultKey);
    const bundleService = new VaultBundleService({ ownerId, database, hostRepository, groupRepository, vaultService });
    const snapshotService = new SyncSnapshotService({
      ownerId,
      database,
      bundleService,
      workspaceService,
      workspaceRepository,
      snippetService,
      snippetRepository,
      hostRepository,
      groupRepository,
      identityRepository,
      vaultService
    });

    const plaintext = await snapshotService.create(ownerId, vaultKey);
    const parsed = JSON.parse(plaintext.toString('utf8')) as Record<string, unknown> & { groups: unknown[]; hosts: unknown[] };
    expect(Object.keys(parsed).sort()).toEqual(['groups', 'hosts', 'identities', 'schemaVersion', 'snippets', 'workspace'].sort());
    expect(parsed).not.toHaveProperty('transferJobs');
    expect(parsed).not.toHaveProperty('commandRuns');
    expect(parsed).not.toHaveProperty('activity');
    expect(parsed).not.toHaveProperty('liveSessions');
    expect(parsed).not.toHaveProperty('terminalId');
    expect(snapshotService.validate(plaintext).snippets).toHaveLength(1);

    const accounts = new AccountRepository(database);
    const account = accounts.createAccount({ id: 'account-sync', email: 'sync@example.com', passwordHash: 'hashhashhashhash' });
    const device = accounts.createDevice({ id: 'device-sync', accountId: account.id, label: 'Web', platform: 'web' });
    const store = new BlindSyncRepository(database);
    const syncService = new SyncService({ store, snapshotService });
    const vaultConfig = {
      version: 1 as const,
      kdf: { ...ARGON2ID_PARAMS, salt: Buffer.alloc(16, 8).toString('base64') },
      wrappedVaultKey: encryptBytes(vaultKey, 'vault:unlock', randomBytes(32))
    };
    const enabledHead = await syncService.enable(account.id, ownerId, device.id, vaultKey, vaultConfig);
    expect(enabledHead).toMatchObject({ revision: 1, keyVersion: 1 });
    expect(syncService.status(account.id)).toEqual(expect.objectContaining({ sync: 'synced', head: enabledHead }));
    await expect(syncService.enable(account.id, ownerId, device.id, vaultKey, vaultConfig)).resolves.toEqual(enabledHead);
    const descriptor = store.getDescriptor(account.id)!;
    const syncKey = unwrapSyncKey(vaultKey, descriptor.vaultId, descriptor.keyVersion, descriptor.wrappedSyncKey);
    const storedEnvelope = store.getEnvelope(account.id)!;
    expect(decryptSyncPayload(syncKey, storedEnvelope)).toEqual(plaintext);
    syncKey.fill(0);

    parsed.groups.push({ id: 'group-failing', name: 'Failing', sortOrder: 0, parentId: null, defaultIdentityId: null, connectionProfile: null });
    parsed.hosts.push({
      id: 'host-failing', name: 'Failing host', address: '10.0.0.9', port: 22, username: 'deploy',
      auth: { type: 'pending', authType: 'password' }, credentialSource: 'group', groupId: 'group-failing',
      jumpHostIds: [], connectionProfileOverrides: null, tags: [], isFavorite: false,
      hostKeyAlgorithm: null, hostKeyFingerprint: null
    });
    const invalidApplyPayload = Buffer.from(JSON.stringify(parsed), 'utf8');
    await expect(snapshotService.apply(ownerId, vaultKey, invalidApplyPayload, 'use-remote'))
      .rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' });
    expect(groupRepository.get('group-failing')).toBeNull();
    expect(hostRepository.getForConnection('host-failing')).toBeNull();
    expect(hostRepository.getForConnection('host-1')?.address).toBe('10.0.0.8');
    expect(snippetRepository.list()).toHaveLength(1);
  });

  it('bootstraps an uninitialized Vault only with an account session and wrapped unlock envelope', async () => {
    const app = await makeApp();
    const created = await new VaultService().create('correct horse battery staple');
    created.vaultKey.fill(0);

    const registered = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: 'http://localhost:4173' },
      payload: { email: 'bootstrap@example.com', password: 'long enough password' }
    });
    expect(registered.statusCode).toBe(201);
    const accountCookie = cookieFrom(registered, 'relay_account_session');

    const envelope = {
      version: created.config.version,
      kdf: created.config.kdf,
      wrappedVaultKey: created.config.wrappedVaultKey
    };
    const unauthenticated = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync',
      headers: { origin: 'http://localhost:4173' },
      payload: { masterPassword: 'correct horse battery staple', vaultUnlockEnvelope: envelope }
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(unauthenticated).error.code).toBe('ACCOUNT_SESSION_INVALID');

    const plaintextAttempt = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync',
      headers: { origin: 'http://localhost:4173', cookie: accountCookie },
      payload: {
        masterPassword: 'correct horse battery staple',
        vaultKey: 'plaintext-vault-key',
        vaultUnlockEnvelope: envelope
      }
    });
    expect(plaintextAttempt.statusCode).toBe(422);
    expect(json<{ error: { code: string } }>(plaintextAttempt).error.code).toBe('SYNC_PAYLOAD_INVALID');
    expect((await app.inject('/api/setup/status')).json()).toEqual({ initialized: false, locked: true });

    const bootstrapped = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync',
      headers: { origin: 'http://localhost:4173', cookie: accountCookie },
      payload: { masterPassword: 'correct horse battery staple', vaultUnlockEnvelope: envelope }
    });
    expect(bootstrapped.statusCode).toBe(201);
    expect(bootstrapped.body).not.toContain('plaintext-vault-key');
    expect(bootstrapped.body).not.toContain('wrappedVaultKey');
    const vaultCookie = cookieFrom(bootstrapped, 'webssh_session');
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: vaultCookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ initialized: true, locked: false });
  });
});
