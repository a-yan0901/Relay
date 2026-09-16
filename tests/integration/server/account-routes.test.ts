import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../../../src/server/app.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';

const MASTER_PASSWORD = 'correct horse battery staple';
const ORIGIN = 'http://localhost:4173';
const databases: ReturnType<typeof openDatabase>[] = [];
const apps: Array<{ close: () => Promise<unknown> }> = [];

const makeApp = async (accountSyncEnabled: boolean) => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
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
    }
  });
  apps.push(app);
  return { app, database };
};

const json = <T>(response: { body: string }): T => JSON.parse(response.body) as T;

const cookieFrom = (response: { headers: Record<string, string | string[] | undefined> }, name: string): string => {
  const header = response.headers['set-cookie'];
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const cookie = values.find((value) => value.startsWith(`${name}=`));
  if (!cookie) throw new Error(`expected ${name} cookie`);
  return cookie.split(';', 1)[0];
};

afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const database of databases.splice(0)) database.close();
});

describe('optional account routes', () => {
  it('stays disabled by default and does not write account rows', async () => {
    const { app, database } = await makeApp(false);
    const before = database.prepare('SELECT COUNT(*) AS count FROM accounts').get() as { count: number };

    const response = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      payload: { email: 'a@example.com', password: 'long enough password' }
    });
    expect(response.statusCode).toBe(501);
    expect(json<{ error: { code: string } }>(response).error.code).toBe('CAPABILITY_UNAVAILABLE');
    expect((database.prepare('SELECT COUNT(*) AS count FROM accounts').get() as { count: number }).count).toBe(before.count);

    const capabilities = await app.inject('/api/capabilities');
    expect(capabilities.json().capabilities).not.toEqual(expect.arrayContaining(['account.auth', 'device.trust', 'sync.encrypted']));
    expect((await app.inject('/api/account/session')).statusCode).toBe(501);
  });

  it('registers, signs in, lists devices, and keeps the Vault session independent on account logout', async () => {
    const { app, database } = await makeApp(true);
    const capabilities = await app.inject('/api/capabilities');
    expect(capabilities.json().capabilities).toEqual(expect.arrayContaining(['account.auth', 'device.trust', 'sync.encrypted']));
    const setup = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { origin: ORIGIN },
      payload: { masterPassword: MASTER_PASSWORD }
    });
    const vaultCookie = cookieFrom(setup, 'webssh_session');

    const registered = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: ORIGIN },
      payload: { email: 'Admin@Example.com', password: 'long enough password', deviceLabel: 'Browser' }
    });
    expect(registered.statusCode).toBe(201);
    expect(registered.body).not.toContain('long enough password');
    expect(registered.body).not.toContain('passwordHash');
    expect(registered.body).not.toContain('token');
    const accountCookie = cookieFrom(registered, 'relay_account_session');
    expect(registered.headers['set-cookie']).toMatch(/HttpOnly/iu);
    expect(registered.headers['set-cookie']).toMatch(/SameSite=Strict/iu);
    expect(registered.headers['set-cookie']).not.toMatch(/Secure/iu);

    const accountStatus = await app.inject({ method: 'GET', url: '/api/account/session', headers: { cookie: accountCookie } });
    expect(accountStatus.statusCode).toBe(200);
    expect(json<{ account: { state: string } }>(accountStatus).account.state).toBe('signed-in');

    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/account/session',
      headers: { origin: ORIGIN },
      payload: { email: 'admin@example.com', password: 'long enough password', platform: 'android', deviceLabel: 'Phone' }
    });
    expect(signedIn.statusCode).toBe(200);
    const secondAccountCookie = cookieFrom(signedIn, 'relay_account_session');
    const devices = await app.inject({ method: 'GET', url: '/api/account/devices', headers: { cookie: accountCookie } });
    expect(devices.statusCode).toBe(200);
    const deviceRows = json<Array<{ id: string; platform: string; current: boolean }>>(devices);
    expect(deviceRows).toHaveLength(2);
    const phone = deviceRows.find((device) => device.platform === 'android');
    expect(phone).toEqual(expect.objectContaining({ current: false }));

    const revoked = await app.inject({
      method: 'DELETE',
      url: `/api/account/devices/${phone!.id}`,
      headers: { origin: ORIGIN, cookie: accountCookie }
    });
    expect(revoked.statusCode).toBe(204);
    const revokedStatus = await app.inject({ method: 'GET', url: '/api/account/session', headers: { cookie: secondAccountCookie } });
    expect(revokedStatus.statusCode).toBe(200);
    expect(json<{ account: null }>(revokedStatus).account).toBeNull();
    expect((await app.inject({ method: 'GET', url: '/api/account/devices', headers: { cookie: secondAccountCookie } })).statusCode).toBe(401);

    const loggedOut = await app.inject({
      method: 'DELETE',
      url: '/api/account/session',
      headers: { origin: ORIGIN, cookie: accountCookie }
    });
    expect(loggedOut.statusCode).toBe(204);
    expect(loggedOut.headers['set-cookie']).toMatch(/relay_account_session=/u);
    const vaultStatus = await app.inject({ method: 'GET', url: '/api/session', headers: { cookie: vaultCookie } });
    expect(json<{ locked: boolean }>(vaultStatus).locked).toBe(false);
    const auditRows = database.prepare('SELECT event_type, metadata_json FROM audit_events ORDER BY rowid').all() as Array<{ event_type: string; metadata_json: string }>;
    expect(auditRows.map((row) => row.event_type)).toEqual(expect.arrayContaining([
      'account_registered',
      'account_signed_in',
      'account_device_revoked',
      'account_signed_out'
    ]));
    expect(auditRows.every((row) => !row.metadata_json.includes('long enough password'))).toBe(true);
  });

  it('rejects unauthorized, malformed, and untrusted account requests without exposing secrets', async () => {
    const { app } = await makeApp(true);
    expect((await app.inject({ method: 'GET', url: '/api/account/devices' })).statusCode).toBe(401);

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: ORIGIN },
      payload: { email: 'a@example.com', password: 'long enough password', extra: 'reject' }
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain('long enough password');

    const untrusted = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: 'https://evil.example' },
      payload: { email: 'a@example.com', password: 'long enough password' }
    });
    expect(untrusted.statusCode).toBe(403);
  });

  it('requires server-side re-authentication for account deletion and supports recovery before expiry', async () => {
    const { app, database } = await makeApp(true);
    database.prepare(`
      INSERT INTO hosts (id, owner_id, name, address, port, username, auth_type, credential_ciphertext, credential_version, created_at, updated_at)
      VALUES ('account-delete-local-host', 'default', 'Keep local after account delete', '10.0.0.9', 22, 'deploy', 'password', 'local-only-ciphertext', 1, '2026-01-01', '2026-01-01')
    `).run();

    const registered = await app.inject({
      method: 'POST',
      url: '/api/account/register',
      headers: { origin: ORIGIN },
      payload: { email: 'account-delete@example.com', password: 'long enough password', deviceLabel: 'Delete browser' }
    });
    const accountCookie = cookieFrom(registered, 'relay_account_session');

    const missingReauth = await app.inject({
      method: 'POST',
      url: '/api/account/deletion',
      headers: { origin: ORIGIN, cookie: accountCookie },
      payload: { confirmDelete: 'DELETE MY ACCOUNT' }
    });
    expect(missingReauth.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(missingReauth).error.code).toBe('ACCOUNT_REAUTH_REQUIRED');

    const forgedReauth = await app.inject({
      method: 'POST',
      url: '/api/account/deletion',
      headers: { origin: ORIGIN, cookie: accountCookie },
      payload: { reauthenticated: true, confirmDelete: 'DELETE MY ACCOUNT' }
    });
    expect(forgedReauth.statusCode).toBe(400);
    expect(json<{ error: { code: string } }>(forgedReauth).error.code).toBe('PROTOCOL_INVALID_MESSAGE');

    const badPassword = await app.inject({
      method: 'POST',
      url: '/api/account/session/reauth',
      headers: { origin: ORIGIN, cookie: accountCookie },
      payload: { password: 'wrong password' }
    });
    expect(badPassword.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(badPassword).error.code).toBe('ACCOUNT_REAUTH_FAILED');

    const reauthenticated = await app.inject({
      method: 'POST',
      url: '/api/account/session/reauth',
      headers: { origin: ORIGIN, cookie: accountCookie },
      payload: { password: 'long enough password' }
    });
    expect(reauthenticated.statusCode).toBe(204);
    expect(reauthenticated.headers['cache-control']).toMatch(/no-store/iu);

    const requested = await app.inject({
      method: 'POST',
      url: '/api/account/deletion',
      headers: { origin: ORIGIN, cookie: accountCookie },
      payload: { confirmDelete: 'DELETE MY ACCOUNT' }
    });
    expect(requested.statusCode).toBe(202);
    expect(json<{ deletion: { kind: string; remainingMs: number } }>(requested).deletion)
      .toEqual(expect.objectContaining({ kind: 'account', remainingMs: expect.any(Number) }));
    expect(requested.headers['set-cookie']).toMatch(/relay_account_session=/u);

    const oldSession = await app.inject({ method: 'GET', url: '/api/account/session', headers: { cookie: accountCookie } });
    expect(json<{ account: null }>(oldSession).account).toBeNull();
    expect((database.prepare('SELECT id, name FROM hosts WHERE id = ?').get('account-delete-local-host')))
      .toEqual({ id: 'account-delete-local-host', name: 'Keep local after account delete' });

    const recoveryLogin = await app.inject({
      method: 'POST',
      url: '/api/account/session',
      headers: { origin: ORIGIN },
      payload: { email: 'account-delete@example.com', password: 'long enough password', deviceLabel: 'Recovery browser' }
    });
    expect(recoveryLogin.statusCode).toBe(200);
    const recoveryCookie = cookieFrom(recoveryLogin, 'relay_account_session');
    const pending = await app.inject({ method: 'GET', url: '/api/account/deletion', headers: { cookie: recoveryCookie } });
    expect(pending.statusCode).toBe(200);
    expect(json<{ deletion: { kind: string } }>(pending).deletion.kind).toBe('account');

    const restoreWithoutReauth = await app.inject({
      method: 'POST',
      url: '/api/account/deletion/restore',
      headers: { origin: ORIGIN, cookie: recoveryCookie },
      payload: {}
    });
    expect(restoreWithoutReauth.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(restoreWithoutReauth).error.code).toBe('ACCOUNT_REAUTH_REQUIRED');

    await expect(app.inject({
      method: 'POST',
      url: '/api/account/session/reauth',
      headers: { origin: ORIGIN, cookie: recoveryCookie },
      payload: { password: 'long enough password' }
    })).resolves.toMatchObject({ statusCode: 204 });
    const restored = await app.inject({
      method: 'POST',
      url: '/api/account/deletion/restore',
      headers: { origin: ORIGIN, cookie: recoveryCookie },
      payload: {}
    });
    expect(restored.statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/account/deletion', headers: { cookie: recoveryCookie } })).json())
      .toEqual({ deletion: null });

    await app.inject({
      method: 'POST',
      url: '/api/account/session/reauth',
      headers: { origin: ORIGIN, cookie: recoveryCookie },
      payload: { password: 'long enough password' }
    });
    const requestedAgain = await app.inject({
      method: 'POST',
      url: '/api/account/deletion',
      headers: { origin: ORIGIN, cookie: recoveryCookie },
      payload: { confirmDelete: 'DELETE MY ACCOUNT' }
    });
    expect(requestedAgain.statusCode).toBe(202);
    database.prepare('UPDATE account_delete_requests SET delete_after = ? WHERE account_id = (SELECT id FROM accounts WHERE email = ?)')
      .run(new Date(Date.now() - 1_000).toISOString(), 'account-delete@example.com');

    const expiredSession = await app.inject({ method: 'GET', url: '/api/account/session', headers: { cookie: recoveryCookie } });
    expect(expiredSession.json()).toEqual({ account: null });
    const expiredLogin = await app.inject({
      method: 'POST',
      url: '/api/account/session',
      headers: { origin: ORIGIN },
      payload: { email: 'account-delete@example.com', password: 'long enough password' }
    });
    expect(expiredLogin.statusCode).toBe(401);
    expect(json<{ error: { code: string } }>(expiredLogin).error.code).toBe('ACCOUNT_AUTH_FAILED');
    expect(database.prepare('SELECT id FROM accounts WHERE email = ?').get('account-delete@example.com')).toBeUndefined();
    expect(database.prepare('SELECT id FROM hosts WHERE id = ?').get('account-delete-local-host')).toBeTruthy();
  });
});
