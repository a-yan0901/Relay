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
});
