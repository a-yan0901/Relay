import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import { AccountService } from '../../../src/server/account/account-service.js';
import { AccountSessionStore } from '../../../src/server/account/account-session-store.js';
import { verifyAccountPassword } from '../../../src/server/account/account-crypto.js';
import { getAccountSessionId, setAccountSessionCookie } from '../../../src/server/auth/account-cookie.js';
import { openDatabase } from '../../../src/server/db/database.js';
import { migrate } from '../../../src/server/db/migrations.js';
import { AccountRepository } from '../../../src/server/db/repositories.js';

const databases: ReturnType<typeof openDatabase>[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

const createService = (
  now: { value: number } = { value: Date.now() },
  timeouts: { idleTimeoutMs?: number; absoluteTimeoutMs?: number } = {}
) => {
  const database = openDatabase(':memory:');
  migrate(database);
  databases.push(database);
  const repository = new AccountRepository(database);
  const sessionStore = new AccountSessionStore({
    idleTimeoutMs: timeouts.idleTimeoutMs ?? 60_000,
    absoluteTimeoutMs: timeouts.absoluteTimeoutMs ?? 180_000,
    now: () => now.value
  });
  return {
    now,
    repository,
    sessionStore,
    service: new AccountService({ accountRepository: repository, sessionStore })
  };
};

const device = { label: 'Chrome on Linux', platform: 'web' as const };

describe('account service', () => {
  it('normalizes email, hashes passwords, and uses one auth error for unknown accounts and bad passwords', async () => {
    const { service, repository } = createService();
    const session = await service.register('  Admin@Example.COM ', 'correct horse battery', device);
    const stored = repository.getAccountByEmail('admin@example.com');

    expect(session).toMatchObject({ accountId: stored?.id, state: 'signed-in' });
    expect(stored?.email).toBe('admin@example.com');
    expect(stored?.passwordHash).not.toBe('correct horse battery');
    expect(stored?.passwordHash).toMatch(/^\$argon2id\$/u);
    expect(await verifyAccountPassword('correct horse battery', stored!.passwordHash)).toBe(true);

    await expect(service.signIn('admin@example.com', 'wrong password', device))
      .rejects.toMatchObject({ code: 'ACCOUNT_AUTH_FAILED' });
    await expect(service.signIn('missing@example.com', 'wrong password', device))
      .rejects.toMatchObject({ code: 'ACCOUNT_AUTH_FAILED' });
  });

  it('rejects weak passwords and duplicate normalized emails', async () => {
    const { service } = createService();
    await expect(service.register('admin@example.com', 'short', device))
      .rejects.toMatchObject({ code: 'ACCOUNT_PASSWORD_INVALID' });

    await service.register('admin@example.com', 'long enough password', device);
    await expect(service.register(' ADMIN@EXAMPLE.COM ', 'another password', device))
      .rejects.toMatchObject({ code: 'ACCOUNT_EXISTS' });
  });

  it('keeps session tokens out of records and expires them on idle or absolute timeout', async () => {
    const clock = { value: 1_000_000 };
    const { service, sessionStore } = createService(clock);
    const session = await service.register('admin@example.com', 'long enough password', device);
    const token = service.issueSessionToken(session);
    const record = sessionStore.get(token);

    expect(token).toHaveLength(43);
    expect(record).toEqual(expect.objectContaining({ accountId: session.accountId, deviceId: session.deviceId }));
    expect(record?.id).not.toBe(token);
    expect(record).not.toHaveProperty('token');
    expect(service.status(token)).toEqual(expect.objectContaining({
      accountId: session.accountId,
      deviceId: session.deviceId,
      state: 'signed-in'
    }));

    clock.value += 60_001;
    expect(service.status(token)).toBeNull();

    const freshToken = sessionStore.create(session.accountId, session.deviceId);
    clock.value += 180_001;
    expect(sessionStore.get(freshToken)).toBeNull();
  });

  it('requires the current account session to re-authenticate and expires that proof after ten minutes', async () => {
    const clock = { value: 1_000_000 };
    const { service } = createService(clock, { idleTimeoutMs: 15 * 60 * 1000, absoluteTimeoutMs: 30 * 60 * 1000 });
    const session = await service.register('reauth@example.com', 'long enough password', device);
    const token = service.issueSessionToken(session);

    expect(() => service.assertReauthenticated(token)).toThrowError(new AppError('ACCOUNT_REAUTH_REQUIRED'));
    await expect(service.reauthenticate(token, 'wrong password'))
      .rejects.toMatchObject({ code: 'ACCOUNT_REAUTH_FAILED' });
    expect(() => service.assertReauthenticated(token)).toThrowError(new AppError('ACCOUNT_REAUTH_REQUIRED'));

    await service.reauthenticate(token, 'long enough password');
    expect(() => service.assertReauthenticated(token)).not.toThrow();

    clock.value += 10 * 60 * 1000 + 1;
    expect(service.status(token)).not.toBeNull();
    expect(() => service.assertReauthenticated(token)).toThrowError(new AppError('ACCOUNT_REAUTH_REQUIRED'));
  });

  it('invalidates re-authentication when the current session is signed out', async () => {
    const { service } = createService();
    const session = await service.register('reauth-signout@example.com', 'long enough password', device);
    const token = service.issueSessionToken(session);
    await service.reauthenticate(token, 'long enough password');
    await service.signOut(token);

    expect(() => service.assertReauthenticated(token)).toThrowError(new AppError('ACCOUNT_SESSION_INVALID'));
  });

  it('marks the current device, signs out, and revokes all sessions for a device', async () => {
    const { service, sessionStore } = createService();
    const first = await service.register('admin@example.com', 'long enough password', device);
    const firstToken = service.issueSessionToken(first);
    const second = await service.signIn('admin@example.com', 'long enough password', {
      label: 'Android phone',
      platform: 'android'
    });
    const secondToken = service.issueSessionToken(second);

    expect(await service.listDevices(firstToken)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.deviceId, current: true, revokedAt: null }),
      expect.objectContaining({ id: second.deviceId, current: false, platform: 'android' })
    ]));

    await service.revokeDevice(firstToken, second.deviceId);
    expect(sessionStore.get(secondToken)).toBeNull();
    expect(service.status(secondToken)).toBeNull();
    await expect(service.listDevices(secondToken)).rejects.toMatchObject({ code: 'ACCOUNT_SESSION_INVALID' });

    await service.signOut(firstToken);
    expect(service.status(firstToken)).toBeNull();
  });

  it('does not allow one account to list or revoke another account device', async () => {
    const { service, repository } = createService();
    const accountA = await service.register('a@example.com', 'long enough password', device);
    const tokenA = service.issueSessionToken(accountA);
    const accountB = await service.register('b@example.com', 'long enough password', device);

    await expect(service.revokeDevice(tokenA, accountB.deviceId))
      .rejects.toMatchObject({ code: 'ACCOUNT_DEVICE_REVOKED' });
    expect(repository.getDevice(accountB.accountId, accountB.deviceId)?.revokedAt).toBeNull();
  });

  it('uses an isolated HttpOnly account cookie', () => {
    const reply = { setCookie: vi.fn() };
    const token = 'account-session-token';
    setAccountSessionCookie(reply as never, token, { secure: true });

    expect(reply.setCookie).toHaveBeenCalledWith('relay_account_session', token, expect.objectContaining({
      httpOnly: true,
      sameSite: 'strict',
      secure: true,
      path: '/'
    }));
    expect(getAccountSessionId({ cookies: { relay_account_session: token } } as never)).toBe(token);
  });

  it('maps invalid sessions to a stable application error', async () => {
    const { service } = createService();
    await expect(service.signOut('not-a-session')).resolves.toBeUndefined();
    await expect(service.listDevices('not-a-session')).rejects.toBeInstanceOf(AppError);
  });
});
