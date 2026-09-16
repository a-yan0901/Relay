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
import { SyncService, type SyncTransport } from '../../../src/server/sync/sync-service.js';
import { SnippetService } from '../../../src/server/automation/snippet-service.js';
import { VaultBundleService } from '../../../src/server/workspace/vault-bundle-service.js';
import { WorkspaceRepository } from '../../../src/server/workspace/workspace-repository.js';
import { WorkspaceService } from '../../../src/server/workspace/workspace-service.js';

const databases: ReturnType<typeof openDatabase>[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];
const ORIGIN = 'http://localhost:4173';
const ACCOUNT_PASSWORD = 'long enough password';
const MASTER_PASSWORD = 'correct horse battery staple';
const wrongRecoveryKey = (recoveryKey: string): string => `${recoveryKey.slice(0, -1)}${recoveryKey.endsWith('A') ? 'B' : 'A'}`;

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

const makeApp = async (
  syncTransportFactory?: (database: ReturnType<typeof openDatabase>) => SyncTransport,
  accountSyncEnabled = true,
  syncClock?: () => number
) => {
  const database = createDatabase();
  const syncTransport = syncTransportFactory?.(database);
  const app = await buildApp({
    database,
    config: {
      nodeEnv: 'test',
      port: 3000,
      dataDir: ':memory:',
      trustedOrigins: [ORIGIN],
      sessionIdleTimeoutMs: 60_000,
      maxSessions: 4,
      accountSyncEnabled,
      logLevel: 'silent'
    },
    syncTransport,
    syncClock
  });
  apps.push(app);
  return { app, database };
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
  it('rejects sync access when the capability is disabled or the device is revoked', async () => {
    const disabled = await makeApp(undefined, false);
    const disabledState = await disabled.app.inject({ method: 'GET', url: '/api/sync/v1/state' });
    expect(disabledState.statusCode).toBe(501);
    expect(disabledState.json().error.code).toBe('CAPABILITY_UNAVAILABLE');

    const { app } = await makeApp();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: ORIGIN },
      payload: { email: 'revoked-sync@example.com', password: ACCOUNT_PASSWORD }
    });
    const accountCookie = cookieFrom(registered, 'relay_account_session');
    const deviceId = (registered.json() as { account: { deviceId: string } }).account.deviceId;
    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/account/devices/${deviceId}`,
      headers: { origin: ORIGIN, cookie: accountCookie }
    });
    expect(revoked.statusCode).toBe(204);

    const state = await app.inject({ method: 'GET', url: '/api/sync/v1/state', headers: { cookie: accountCookie } });
    expect(state.statusCode).toBe(401);
    expect(state.json().error.code).toBe('ACCOUNT_SESSION_INVALID');
  });

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
    const { app } = await makeApp();
    const created = await new VaultService().create(MASTER_PASSWORD);
    created.vaultKey.fill(0);

    const registered = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: ORIGIN },
      payload: { email: 'bootstrap@example.com', password: ACCOUNT_PASSWORD }
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
      headers: { origin: ORIGIN },
      payload: { masterPassword: MASTER_PASSWORD, vaultUnlockEnvelope: envelope }
    });
    expect(unauthenticated.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(unauthenticated).error.code).toBe('ACCOUNT_SESSION_INVALID');

    const plaintextAttempt = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync',
      headers: { origin: ORIGIN, cookie: accountCookie },
      payload: {
        masterPassword: MASTER_PASSWORD,
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
      headers: { origin: ORIGIN, cookie: accountCookie },
      payload: { masterPassword: MASTER_PASSWORD, vaultUnlockEnvelope: envelope }
    });
    expect(bootstrapped.statusCode).toBe(201);
    expect(bootstrapped.body).not.toContain('plaintext-vault-key');
    expect(bootstrapped.body).not.toContain('wrappedVaultKey');
    const vaultCookie = cookieFrom(bootstrapped, 'webssh_session');
    const session = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: vaultCookie } });
    expect(session.statusCode).toBe(200);
    expect(session.json()).toEqual({ initialized: true, locked: false });
  });

  it('previews and atomically restores an independent local Vault with master password or recovery key', async () => {
    let syncNow = Date.now();
    const { app, database } = await makeApp(undefined, true, () => syncNow);
    const registered = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: ORIGIN },
      payload: { email: 'new-device@example.com', password: ACCOUNT_PASSWORD, deviceLabel: 'Original device' }
    });
    const originalAccountCookie = cookieFrom(registered, 'relay_account_session');
    const originalSetup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { origin: ORIGIN },
      payload: { masterPassword: MASTER_PASSWORD }
    });
    const originalVaultCookie = cookieFrom(originalSetup, 'webssh_session');
    const originalCookies = `${originalAccountCookie}; ${originalVaultCookie}`;
    const createdHost = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { origin: ORIGIN, cookie: originalCookies },
      payload: { name: 'Recovered host', address: '10.0.0.42', username: 'deploy', auth: { type: 'password', password: 'recovered-host-secret' } }
    });
    expect(createdHost.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/sync/v1/enable', headers: { origin: ORIGIN, cookie: originalCookies } })).statusCode).toBe(201);
    const issued = await app.inject({ method: 'POST', url: '/api/sync/v1/recovery-key/issue', headers: { origin: ORIGIN, cookie: originalCookies } });
    expect(issued.statusCode).toBe(201);
    const recoveryKey = (issued.json() as { recoveryKey: string }).recoveryKey;
    expect((await app.inject({
      method: 'POST',
      url: '/api/sync/v1/recovery-key/confirm',
      headers: { origin: ORIGIN, cookie: originalCookies },
      payload: { recoveryKey }
    })).statusCode).toBe(200);

    const secondAccount = await app.inject({
      method: 'POST',
      url: '/api/account/session',
      headers: { origin: ORIGIN },
      payload: { email: 'new-device@example.com', password: ACCOUNT_PASSWORD, deviceLabel: 'Independent device' }
    });
    expect(secondAccount.statusCode).toBe(200);
    const secondAccountCookie = cookieFrom(secondAccount, 'relay_account_session');

    await app.inject({ method: 'POST', url: '/api/session/lock', headers: { origin: ORIGIN, cookie: originalCookies } });
    database.exec('DELETE FROM audit_events; DELETE FROM hosts; DELETE FROM groups; DELETE FROM identities; DELETE FROM snippets; DELETE FROM workspace_snapshots; DELETE FROM app_config;');
    expect((await app.inject('/api/setup/status')).json()).toEqual({ initialized: false, locked: true });

    const unauthenticatedRecovery = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync/preview',
      headers: { origin: ORIGIN },
      payload: { method: 'master-password', secret: MASTER_PASSWORD }
    });
    expect(unauthenticatedRecovery.statusCode).toBe(401);
    expect(unauthenticatedRecovery.json().error.code).toBe('ACCOUNT_SESSION_INVALID');

    const invalidRecoveryInput = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync/preview',
      headers: { origin: ORIGIN, cookie: secondAccountCookie },
      payload: { method: 'recovery-key', secret: recoveryKey, extra: 'must-not-cross-boundary' }
    });
    expect(invalidRecoveryInput.statusCode).toBe(422);
    expect(invalidRecoveryInput.json().error.code).toBe('SYNC_PAYLOAD_INVALID');

    const wrongRecovery = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync/preview',
      headers: { origin: ORIGIN, cookie: secondAccountCookie },
      payload: { method: 'recovery-key', secret: wrongRecoveryKey(recoveryKey) }
    });
    expect(wrongRecovery.statusCode).toBe(401);
    expect(wrongRecovery.json().error.code).toBe('VAULT_UNLOCK_FAILED');

    const masterPreview = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync/preview',
      headers: { origin: ORIGIN, cookie: secondAccountCookie },
      payload: { method: 'master-password', secret: MASTER_PASSWORD }
    });
    expect(masterPreview.statusCode).toBe(200);
    expect(masterPreview.headers['cache-control']).toContain('no-store');
    expect(masterPreview.json()).toEqual(expect.objectContaining({
      vaultId: expect.any(String),
      revision: 1,
      hostCount: 1,
      groupCount: 0,
      identityCount: 0,
      snippetCount: 0,
      workspaceIncluded: true,
      conflictTypes: [],
      previewId: expect.any(String),
      expiresAt: expect.any(String)
    }));

    const recoveryPreview = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync/preview',
      headers: { origin: ORIGIN, cookie: secondAccountCookie },
      payload: { method: 'recovery-key', secret: recoveryKey }
    });
    expect(recoveryPreview.statusCode).toBe(200);
    const preview = recoveryPreview.json() as { previewId: string };
    expect(recoveryPreview.body).not.toContain(recoveryKey);
    expect(recoveryPreview.body).not.toContain(MASTER_PASSWORD);

    syncNow += 10 * 60 * 1000 + 1;
    const expiredApply = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync/apply',
      headers: { origin: ORIGIN, cookie: secondAccountCookie },
      payload: { previewId: preview.previewId, method: 'recovery-key', secret: recoveryKey }
    });
    expect(expiredApply.statusCode).toBe(404);
    expect(expiredApply.json().error.code).toBe('SYNC_NOT_FOUND');
    expect((await app.inject('/api/setup/status')).json()).toEqual({ initialized: false, locked: true });

    const freshRecoveryPreview = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync/preview',
      headers: { origin: ORIGIN, cookie: secondAccountCookie },
      payload: { method: 'recovery-key', secret: recoveryKey }
    });
    expect(freshRecoveryPreview.statusCode).toBe(200);
    const freshPreview = freshRecoveryPreview.json() as { previewId: string; payloadHash: string };

    database.prepare('UPDATE sync_envelopes SET payload_hash = ?').run('b'.repeat(64));
    const changedRemoteApply = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync/apply',
      headers: { origin: ORIGIN, cookie: secondAccountCookie },
      payload: { previewId: freshPreview.previewId, method: 'recovery-key', secret: recoveryKey }
    });
    expect(changedRemoteApply.statusCode).toBe(409);
    expect(changedRemoteApply.json().error.code).toBe('SYNC_CONFLICT');
    expect((await app.inject('/api/setup/status')).json()).toEqual({ initialized: false, locked: true });

    database.prepare('UPDATE sync_envelopes SET payload_hash = ?').run(freshPreview.payloadHash);
    const finalRecoveryPreview = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync/preview',
      headers: { origin: ORIGIN, cookie: secondAccountCookie },
      payload: { method: 'recovery-key', secret: recoveryKey }
    });
    expect(finalRecoveryPreview.statusCode).toBe(200);
    const finalPreview = finalRecoveryPreview.json() as { previewId: string };

    const applied = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync/apply',
      headers: { origin: ORIGIN, cookie: secondAccountCookie },
      payload: { previewId: finalPreview.previewId, method: 'recovery-key', secret: recoveryKey }
    });
    expect(applied.statusCode).toBe(201);
    expect(applied.json()).toEqual({ initialized: true, locked: false });
    expect(applied.body).not.toContain(recoveryKey);
    expect(applied.body).not.toContain('recovered-host-secret');
    const restoredVaultCookie = cookieFrom(applied, 'webssh_session');
    const restoredHost = await app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie: restoredVaultCookie } });
    expect(restoredHost.statusCode).toBe(200);
    expect(restoredHost.json()).toEqual([expect.objectContaining({ name: 'Recovered host', address: '10.0.0.42' })]);

    // The route normally rejects a replay after local initialization. Remove only
    // the marker here so the one-time preview token itself is exercised.
    database.exec('DELETE FROM app_config;');
    const replay = await app.inject({
      method: 'POST',
      url: '/api/setup/from-sync/apply',
      headers: { origin: ORIGIN, cookie: secondAccountCookie },
      payload: { previewId: finalPreview.previewId, method: 'recovery-key', secret: recoveryKey }
    });
    expect(replay.statusCode).toBe(404);
    expect(replay.json().error.code).toBe('SYNC_NOT_FOUND');
  });

  it('exposes opaque sync routes while keeping preview and enable behind the local Vault session', async () => {
    const { app } = await makeApp();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: ORIGIN },
      payload: { email: 'routes@example.com', password: ACCOUNT_PASSWORD }
    });
    const accountCookie = cookieFrom(registered, 'relay_account_session');

    const initialState = await app.inject({ method: 'GET', url: '/api/sync/v1/state', headers: { cookie: accountCookie } });
    expect(initialState.statusCode).toBe(200);
    expect(initialState.json()).toEqual(expect.objectContaining({ sync: 'local-only', head: null }));
    expect((await app.inject({ method: 'GET', url: '/api/sync/v1/descriptor', headers: { cookie: accountCookie } })).statusCode).toBe(200);

    const lockedEnable = await app.inject({ method: 'POST', url: '/api/sync/v1/enable', headers: { origin: ORIGIN, cookie: accountCookie } });
    expect(lockedEnable.statusCode).toBe(401);
    expect(lockedEnable.json().error.code).toBe('SESSION_INVALID');
    const lockedPreview = await app.inject({ method: 'POST', url: '/api/sync/v1/pull/preview', headers: { origin: ORIGIN, cookie: accountCookie } });
    expect(lockedPreview.statusCode).toBe(401);
    expect(lockedPreview.json().error.code).toBe('SESSION_INVALID');

    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: { origin: ORIGIN }, payload: { masterPassword: MASTER_PASSWORD } });
    const vaultCookie = cookieFrom(setup, 'webssh_session');
    const cookies = `${accountCookie}; ${vaultCookie}`;
    const enabled = await app.inject({ method: 'POST', url: '/api/sync/v1/enable', headers: { origin: ORIGIN, cookie: cookies } });
    expect(enabled.statusCode).toBe(201);
    expect(enabled.body).not.toContain('MASTER_PASSWORD');

    const descriptorResponse = await app.inject({ method: 'GET', url: '/api/sync/v1/descriptor', headers: { cookie: accountCookie } });
    expect(descriptorResponse.statusCode).toBe(200);
    const descriptorBody = descriptorResponse.json() as { descriptor: Record<string, unknown> };
    expect(descriptorBody.descriptor).toEqual(expect.objectContaining({ vaultId: expect.any(String), wrappedSyncKey: expect.any(Object) }));
    expect(descriptorResponse.body).not.toContain('password');
    expect(descriptorResponse.body).not.toContain('privateKey');

    const envelopeResponse = await app.inject({ method: 'GET', url: '/api/sync/v1/envelope', headers: { cookie: accountCookie } });
    expect(envelopeResponse.statusCode).toBe(200);
    expect(envelopeResponse.json()).toEqual({ envelope: expect.objectContaining({ ciphertext: expect.any(String), nonce: expect.any(String) }) });
    expect(envelopeResponse.body).not.toContain('correct horse battery staple');

    const preview = await app.inject({ method: 'POST', url: '/api/sync/v1/pull/preview', headers: { origin: ORIGIN, cookie: cookies } });
    expect(preview.statusCode).toBe(200);
    expect(preview.json()).toEqual(expect.objectContaining({ remoteRevision: 1 }));

    const duplicatePush = await app.inject({
      method: 'PUT',
      url: '/api/sync/v1/envelope',
      headers: {
        origin: ORIGIN,
        cookie: accountCookie,
        'idempotency-key': `enable:${(registered.json() as { account: { accountId: string } }).account.accountId}:${descriptorBody.descriptor.vaultId as string}`
      },
      payload: (envelopeResponse.json() as { envelope: unknown }).envelope
    });
    expect(duplicatePush.statusCode).toBe(200);
    expect(duplicatePush.json()).toEqual(expect.objectContaining({ revision: 1 }));
  });

  it('persists pending before a provider failure and retries the same envelope without blocking local mutation', async () => {
    const idempotencyKeys: string[] = [];
    let pushCount = 0;
    let releaseFirstPush!: () => void;
    let markFirstPushStarted!: () => void;
    const firstPushStarted = new Promise<void>((resolve) => { markFirstPushStarted = resolve; });
    const firstPushRelease = new Promise<void>((resolve) => { releaseFirstPush = resolve; });
    const { app, database } = await makeApp((db) => {
      const store = new BlindSyncRepository(db);
      return {
        push: async (accountId, envelope, idempotencyKey) => {
          pushCount += 1;
          idempotencyKeys.push(idempotencyKey);
          if (pushCount === 1) {
            markFirstPushStarted();
            await firstPushRelease;
            throw new Error('provider returned 503');
          }
          return store.putEnvelope(accountId, envelope, idempotencyKey);
        }
      };
    });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: ORIGIN },
      payload: { email: 'pending@example.com', password: ACCOUNT_PASSWORD }
    });
    const accountCookie = cookieFrom(registered, 'relay_account_session');
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: { origin: ORIGIN }, payload: { masterPassword: MASTER_PASSWORD } });
    const vaultCookie = cookieFrom(setup, 'webssh_session');
    const cookies = `${accountCookie}; ${vaultCookie}`;
    expect((await app.inject({ method: 'POST', url: '/api/sync/v1/enable', headers: { origin: ORIGIN, cookie: cookies } })).statusCode).toBe(201);

    const host = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { origin: ORIGIN, cookie: cookies },
      payload: { name: 'Pending host', address: '127.0.0.1', username: 'fixture', auth: { type: 'password', password: 'fixture-password' } }
    });
    expect(host.statusCode).toBe(201);
    await firstPushStarted;
    const accountId = (registered.json() as { account: { accountId: string } }).account.accountId;
    const pending = database.prepare('SELECT status, pending_envelope_json FROM sync_client_state WHERE account_id = ?').get(accountId) as { status: string; pending_envelope_json: string | null };
    expect(pending.status).toBe('pending');
    expect(pending.pending_envelope_json).not.toBeNull();

    releaseFirstPush();
    const retried = await app.inject({ method: 'POST', url: '/api/sync/v1/retry', headers: { origin: ORIGIN, cookie: accountCookie } });
    expect(retried.statusCode).toBe(202);
    expect(retried.json()).toEqual(expect.objectContaining({ sync: 'synced', pendingCount: 0 }));
    expect(pushCount).toBe(2);
    expect(idempotencyKeys[1]).toBe(idempotencyKeys[0]);
  });

  it('does not mark a completed in-flight push as synced after the Vault is locked', async () => {
    let releasePush!: () => void;
    let markPushStarted!: () => void;
    let markPushFinished!: () => void;
    const pushStarted = new Promise<void>((resolve) => { markPushStarted = resolve; });
    const pushRelease = new Promise<void>((resolve) => { releasePush = resolve; });
    const pushFinished = new Promise<void>((resolve) => { markPushFinished = resolve; });
    const { app } = await makeApp((db) => {
      const store = new BlindSyncRepository(db);
      return {
        push: async (accountId, envelope, idempotencyKey) => {
          markPushStarted();
          await pushRelease;
          const head = store.putEnvelope(accountId, envelope, idempotencyKey);
          markPushFinished();
          return head;
        }
      };
    });
    const registered = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: ORIGIN },
      payload: { email: 'lock-during-sync@example.com', password: ACCOUNT_PASSWORD }
    });
    const accountCookie = cookieFrom(registered, 'relay_account_session');
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: { origin: ORIGIN }, payload: { masterPassword: MASTER_PASSWORD } });
    const vaultCookie = cookieFrom(setup, 'webssh_session');
    const cookies = `${accountCookie}; ${vaultCookie}`;
    expect((await app.inject({ method: 'POST', url: '/api/sync/v1/enable', headers: { origin: ORIGIN, cookie: cookies } })).statusCode).toBe(201);

    const host = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { origin: ORIGIN, cookie: cookies },
      payload: { name: 'Lock boundary host', address: '127.0.0.1', username: 'fixture', auth: { type: 'password', password: 'fixture-password' } }
    });
    expect(host.statusCode).toBe(201);
    await pushStarted;

    const locked = await app.inject({ method: 'POST', url: '/api/session/lock', headers: { origin: ORIGIN, cookie: vaultCookie } });
    expect(locked.statusCode).toBe(204);
    releasePush();
    await pushFinished;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const state = await app.inject({ method: 'GET', url: '/api/sync/v1/state', headers: { cookie: accountCookie } });
    expect(state.statusCode).toBe(200);
    expect(state.json()).toEqual(expect.objectContaining({ sync: 'pending', pendingCount: 1 }));
  });

  it('issues, confirms, and safely rotates a recovery key without persisting the plaintext', async () => {
    const { app, database } = await makeApp();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: ORIGIN },
      payload: { email: 'recovery-key@example.com', password: ACCOUNT_PASSWORD }
    });
    const accountCookie = cookieFrom(registered, 'relay_account_session');
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: { origin: ORIGIN }, payload: { masterPassword: MASTER_PASSWORD } });
    const vaultCookie = cookieFrom(setup, 'webssh_session');
    const cookies = `${accountCookie}; ${vaultCookie}`;
    expect((await app.inject({ method: 'POST', url: '/api/sync/v1/enable', headers: { origin: ORIGIN, cookie: cookies } })).statusCode).toBe(201);

    const issued = await app.inject({
      method: 'POST',
      url: '/api/sync/v1/recovery-key/issue',
      headers: { origin: ORIGIN, cookie: cookies }
    });
    expect(issued.statusCode).toBe(201);
    expect(issued.headers['cache-control']).toBe('no-store');
    const first = issued.json() as { recoveryKey: string; keyVersion: number; status: string; recovery: unknown };
    expect(first).toEqual(expect.objectContaining({
      recoveryKey: expect.stringMatching(/^RLY-RK1(?:-[A-Z2-7]{4})+$/u),
      keyVersion: 1,
      status: 'pending-confirmation'
    }));
    expect(first.recovery).toEqual({ status: 'pending-confirmation', activeKeyVersion: null, pendingKeyVersion: 1 });
    const accountId = (registered.json() as { account: { accountId: string } }).account.accountId;
    const rawDescriptor = database.prepare('SELECT vault_unlock_envelope_json FROM sync_vaults WHERE account_id = ?').get(accountId) as { vault_unlock_envelope_json: string };
    expect(rawDescriptor.vault_unlock_envelope_json).toContain('pendingRecoveryWrappedVaultKey');
    expect(rawDescriptor.vault_unlock_envelope_json).not.toContain(first.recoveryKey);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/sync/v1/recovery-key/confirm',
      headers: { origin: ORIGIN, cookie: cookies },
      payload: { recoveryKey: wrongRecoveryKey(first.recoveryKey) }
    });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.json().error.code).toBe('VAULT_UNLOCK_FAILED');
    expect((await app.inject({ method: 'GET', url: '/api/sync/v1/state', headers: { cookie: accountCookie } })).json()).toEqual(expect.objectContaining({
      recovery: { status: 'pending-confirmation', activeKeyVersion: null, pendingKeyVersion: 1 }
    }));

    const confirmed = await app.inject({
      method: 'POST',
      url: '/api/sync/v1/recovery-key/confirm',
      headers: { origin: ORIGIN, cookie: cookies },
      payload: { recoveryKey: first.recoveryKey }
    });
    expect(confirmed.statusCode).toBe(200);
    expect(confirmed.json()).toEqual({ status: 'configured', activeKeyVersion: 1, pendingKeyVersion: null });

    const configuredDescriptor = JSON.parse((database.prepare('SELECT vault_unlock_envelope_json FROM sync_vaults WHERE account_id = ?').get(accountId) as { vault_unlock_envelope_json: string }).vault_unlock_envelope_json) as {
      recoveryWrappedVaultKey: { ciphertext: string };
      pendingRecoveryWrappedVaultKey?: unknown;
    };
    const oldCiphertext = configuredDescriptor.recoveryWrappedVaultKey.ciphertext;
    expect(configuredDescriptor.pendingRecoveryWrappedVaultKey).toBeUndefined();

    const rotated = await app.inject({
      method: 'POST',
      url: '/api/sync/v1/recovery-key/issue',
      headers: { origin: ORIGIN, cookie: cookies }
    });
    expect(rotated.statusCode).toBe(201);
    const second = rotated.json() as { recoveryKey: string; keyVersion: number; status: string };
    expect(second.keyVersion).toBe(2);
    expect(second.status).toBe('pending-confirmation');
    const pendingDescriptor = JSON.parse((database.prepare('SELECT vault_unlock_envelope_json FROM sync_vaults WHERE account_id = ?').get(accountId) as { vault_unlock_envelope_json: string }).vault_unlock_envelope_json) as {
      recoveryWrappedVaultKey: { ciphertext: string };
      pendingRecoveryWrappedVaultKey: { ciphertext: string };
    };
    expect(pendingDescriptor.recoveryWrappedVaultKey.ciphertext).toBe(oldCiphertext);
    expect(pendingDescriptor.pendingRecoveryWrappedVaultKey.ciphertext).not.toBe(oldCiphertext);

    const replaced = await app.inject({
      method: 'POST',
      url: '/api/sync/v1/recovery-key/issue',
      headers: { origin: ORIGIN, cookie: cookies }
    });
    expect(replaced.statusCode).toBe(201);
    const third = replaced.json() as { recoveryKey: string; keyVersion: number; status: string };
    expect(third.keyVersion).toBe(3);
    expect(third.status).toBe('pending-confirmation');

    const stale = await app.inject({
      method: 'POST',
      url: '/api/sync/v1/recovery-key/confirm',
      headers: { origin: ORIGIN, cookie: cookies },
      payload: { recoveryKey: second.recoveryKey }
    });
    expect(stale.statusCode).toBe(401);
    expect(stale.json().error.code).toBe('VAULT_UNLOCK_FAILED');
    expect((await app.inject({ method: 'GET', url: '/api/sync/v1/state', headers: { cookie: accountCookie } })).json()).toEqual(expect.objectContaining({
      recovery: { status: 'pending-confirmation', activeKeyVersion: 1, pendingKeyVersion: 3 }
    }));

    const confirmedRotation = await app.inject({
      method: 'POST',
      url: '/api/sync/v1/recovery-key/confirm',
      headers: { origin: ORIGIN, cookie: cookies },
      payload: { recoveryKey: third.recoveryKey }
    });
    expect(confirmedRotation.statusCode).toBe(200);
    expect(confirmedRotation.headers['cache-control']).toBe('no-store');
    expect(confirmedRotation.json()).toEqual({ status: 'configured', activeKeyVersion: 3, pendingKeyVersion: null });

    const noPending = await app.inject({
      method: 'POST',
      url: '/api/sync/v1/recovery-key/confirm',
      headers: { origin: ORIGIN, cookie: cookies },
      payload: { recoveryKey: third.recoveryKey }
    });
    expect(noPending.statusCode).toBe(409);
    expect(noPending.json().error.code).toBe('SYNC_RECOVERY_KEY_NOT_READY');
  });

  it('requires explicit deletion confirmation, supports recovery, and preserves local Vault data', async () => {
    const { app, database } = await makeApp();
    const registered = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: ORIGIN },
      payload: { email: 'delete@example.com', password: ACCOUNT_PASSWORD }
    });
    const accountCookie = cookieFrom(registered, 'relay_account_session');
    const setup = await app.inject({ method: 'POST', url: '/api/setup', headers: { origin: ORIGIN }, payload: { masterPassword: MASTER_PASSWORD } });
    const vaultCookie = cookieFrom(setup, 'webssh_session');
    const cookies = `${accountCookie}; ${vaultCookie}`;
    const host = await app.inject({
      method: 'POST',
      url: '/api/hosts',
      headers: { origin: ORIGIN, cookie: cookies },
      payload: { name: 'Retained local host', address: '127.0.0.1', username: 'fixture', auth: { type: 'password', password: 'fixture-password' } }
    });
    expect(host.statusCode).toBe(201);
    expect((await app.inject({ method: 'POST', url: '/api/sync/v1/enable', headers: { origin: ORIGIN, cookie: cookies } })).statusCode).toBe(201);

    const missingConfirmation = await app.inject({ method: 'POST', url: '/api/sync/v1/vault/delete', headers: { origin: ORIGIN, cookie: accountCookie }, payload: {} });
    expect(missingConfirmation.statusCode).toBe(400);
    expect(missingConfirmation.json().error.code).toBe('SYNC_DELETE_CONFIRMATION_REQUIRED');
    const missingReauth = await app.inject({
      method: 'POST',
      url: '/api/sync/v1/vault/delete',
      headers: { origin: ORIGIN, cookie: accountCookie },
      payload: { reauthenticated: false, confirmDelete: 'DELETE MY CLOUD VAULT' }
    });
    expect(missingReauth.statusCode).toBe(400);
    expect(missingReauth.json().error.code).toBe('SYNC_DELETE_CONFIRMATION_REQUIRED');

    const requested = await app.inject({
      method: 'POST',
      url: '/api/sync/v1/vault/delete',
      headers: { origin: ORIGIN, cookie: accountCookie },
      payload: { reauthenticated: true, confirmDelete: 'DELETE MY CLOUD VAULT' }
    });
    expect(requested.statusCode).toBe(202);
    const state = await app.inject({ method: 'GET', url: '/api/sync/v1/state', headers: { cookie: accountCookie } });
    expect(state.json()).toEqual(expect.objectContaining({ deletion: expect.objectContaining({ deleteAfter: expect.any(String), remainingMs: expect.any(Number) }) }));
    expect((await app.inject({ method: 'GET', url: '/api/sync/v1/descriptor', headers: { cookie: accountCookie } })).json().descriptor).not.toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: vaultCookie } })).json()).toEqual({ initialized: true, locked: false });

    const restored = await app.inject({ method: 'POST', url: '/api/sync/v1/vault/restore', headers: { origin: ORIGIN, cookie: accountCookie } });
    expect(restored.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/sync/v1/state', headers: { cookie: accountCookie } })).json()).not.toHaveProperty('deletion');

    const requestedAgain = await app.inject({
      method: 'POST',
      url: '/api/sync/v1/vault/delete',
      headers: { origin: ORIGIN, cookie: accountCookie },
      payload: { reauthenticated: true, confirmDelete: 'DELETE MY CLOUD VAULT' }
    });
    expect(requestedAgain.statusCode).toBe(202);
    database.prepare('UPDATE sync_delete_requests SET delete_after = ? WHERE account_id = (SELECT id FROM accounts WHERE email = ?)').run(new Date(Date.now() - 1_000).toISOString(), 'delete@example.com');

    const expired = await app.inject({ method: 'GET', url: '/api/sync/v1/state', headers: { cookie: accountCookie } });
    expect(expired.statusCode).toBe(200);
    expect(expired.json()).toEqual({ sync: 'local-only', head: null, pendingCount: 0 });
    expect((await app.inject({ method: 'GET', url: '/api/sync/v1/descriptor', headers: { cookie: accountCookie } })).json()).toEqual({ descriptor: null });
    expect((await app.inject({ method: 'GET', url: '/api/hosts', headers: { cookie: vaultCookie } })).json()).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'Retained local host' })]));
  });
});
