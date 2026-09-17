import { describe, expect, it } from 'vitest';

import { CloudBrowserSessionStore } from '../../../src/server/cloud/cloud-session-store.js';

const account = {
  accountId: 'account-1',
  deviceId: 'device-1',
  state: 'signed-in' as const,
  expiresAt: '2026-10-18T00:00:00.000Z',
  trusted: true
};

describe('bounded browser cloud session store', () => {
  it('keeps the cloud token server-side and expires idle sessions', () => {
    let now = 1_000;
    const store = new CloudBrowserSessionStore({
      maxSessions: 2,
      idleTimeoutMs: 100,
      absoluteTimeoutMs: 1_000,
      now: () => now
    });

    const cookie = store.create('a'.repeat(43), account);
    expect(cookie).toHaveLength(43);
    expect(store.get(cookie)).toEqual(expect.objectContaining({ token: 'a'.repeat(43), account }));
    now = 1_099;
    expect(store.get(cookie)).not.toBeNull();
    now = 1_200;
    expect(store.get(cookie)).toBeNull();
    expect(store.size).toBe(0);
  });

  it('evicts the oldest session when the bounded capacity is reached', () => {
    let now = 1_000;
    const store = new CloudBrowserSessionStore({ maxSessions: 2, now: () => now });
    const first = store.create('a'.repeat(43), account);
    now += 1;
    const second = store.create('b'.repeat(43), account);
    now += 1;
    const third = store.create('c'.repeat(43), account);

    expect(store.get(first)).toBeNull();
    expect(store.get(second)).not.toBeNull();
    expect(store.get(third)).not.toBeNull();
    expect(store.size).toBe(2);
  });

  it('revokes only the requested browser session', () => {
    const store = new CloudBrowserSessionStore({ maxSessions: 2 });
    const first = store.create('a'.repeat(43), account);
    const second = store.create('b'.repeat(43), { ...account, deviceId: 'device-2' });

    expect(store.revoke(first)).toBe(true);
    expect(store.get(first)).toBeNull();
    expect(store.get(second)).not.toBeNull();
    expect(store.revoke(first)).toBe(false);
  });

  it('stores only a bounded sync cursor and returns defensive copies', () => {
    const store = new CloudBrowserSessionStore();
    const cookie = store.create('a'.repeat(43), account);
    const cursor = { remoteRevision: 3, remotePayloadHash: 'a'.repeat(64), localPayloadHash: 'b'.repeat(64) };

    store.setCloudSyncCursor(cookie, cursor);
    cursor.remoteRevision = 99;
    const stored = store.get(cookie);
    expect(stored?.cloudSyncCursor).toEqual({ remoteRevision: 3, remotePayloadHash: 'a'.repeat(64), localPayloadHash: 'b'.repeat(64) });
    if (stored?.cloudSyncCursor) stored.cloudSyncCursor.localPayloadHash = 'c'.repeat(64);
    expect(store.get(cookie)?.cloudSyncCursor?.localPayloadHash).toBe('b'.repeat(64));
  });
});
