import { describe, expect, it } from 'vitest';

import { CloudAccountSession } from '../../../src/shared/cloud/account-session.js';
import { AppError } from '../../../src/shared/errors.js';

const account = {
  accountId: 'account-1',
  deviceId: 'device-1',
  state: 'signed-in' as const,
  expiresAt: '2026-10-18T00:00:00.000Z',
  trusted: true
};

const createStore = (initial: string | null = null) => {
  let value = initial;
  return {
    async load() { return value; },
    async save(next: string) { value = next; },
    async clear() { value = null; },
    value: () => value
  };
};

describe('platform-neutral cloud account session', () => {
  it('stores only the opaque token and exposes the same account lifecycle on every platform', async () => {
    const store = createStore();
    let refreshCount = 0;
    const client = {
      async register() { return { account, token: 'a'.repeat(43) }; },
      async signIn() { return { account, token: 'a'.repeat(43) }; },
      async getSession() { return { account }; },
      async refresh() { refreshCount += 1; return { account, token: 'b'.repeat(43) }; },
      async signOut() {},
      async listDevices() { return []; },
      async revokeDevice() {},
      async trustDevice() {}
    };
    const session = new CloudAccountSession({ client, platform: 'android', deviceLabel: 'Phone', tokenStore: store });

    await expect(session.signIn('user@example.com', 'opaque-password')).resolves.toEqual(account);
    expect(store.value()).toBe('a'.repeat(43));
    await expect(session.status()).resolves.toEqual(account);
    await expect(session.refresh()).resolves.toEqual(account);
    expect(refreshCount).toBe(1);
    expect(store.value()).toBe('b'.repeat(43));
    await session.trustDevice('device-2');
    await session.signOut();
    expect(store.value()).toBeNull();
  });

  it('clears an invalid token but preserves network/auth errors for the caller', async () => {
    const store = createStore('a'.repeat(43));
    const client = {
      async getSession() { throw new AppError('ACCOUNT_SESSION_INVALID'); },
      async listDevices() { return []; },
      async revokeDevice() {},
      async trustDevice() {}
    };
    const session = new CloudAccountSession({ client, platform: 'desktop', tokenStore: store });

    await expect(session.status()).resolves.toBeNull();
    expect(store.value()).toBeNull();
  });

  it('does not issue cloud calls in local-only mode when no token exists', async () => {
    const store = createStore();
    let calls = 0;
    const session = new CloudAccountSession({
      client: { async listDevices() { calls += 1; return []; }, async revokeDevice() {}, async trustDevice() {} },
      platform: 'web',
      tokenStore: store
    });

    await expect(session.listDevices()).rejects.toMatchObject({ code: 'ACCOUNT_SESSION_INVALID' });
    expect(calls).toBe(0);
  });
});
