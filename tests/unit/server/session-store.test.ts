import { afterEach, describe, expect, it } from 'vitest';

import { SessionStore } from '../../../src/server/auth/session-store.js';

const stores: SessionStore[] = [];

afterEach(() => {
  for (const store of stores.splice(0)) {
    store.revokeAll();
  }
});

describe('SessionStore', () => {
  it('creates opaque non-repeating sessions and retrieves their vault keys', () => {
    const store = new SessionStore({ now: () => 1_000, idleTimeoutMs: 5_000 });
    stores.push(store);
    const firstKey = Buffer.alloc(32, 1);
    const secondKey = Buffer.alloc(32, 2);

    const firstId = store.create(firstKey);
    const secondId = store.create(secondKey);

    expect(firstId).not.toBe(secondId);
    expect(firstId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(store.get(firstId)).toEqual(expect.objectContaining({
      id: firstId,
      createdAt: 1_000,
      lastUsedAt: 1_000,
      activeConnections: 0
    }));
    expect(store.get(firstId)?.vaultKey.equals(firstKey)).toBe(true);
  });

  it('expires idle sessions and clears their key buffer', () => {
    let currentTime = 1_000;
    const store = new SessionStore({ now: () => currentTime, idleTimeoutMs: 5_000 });
    stores.push(store);
    const key = Buffer.alloc(32, 7);
    const id = store.create(key);

    currentTime = 5_999;
    expect(store.get(id)).not.toBeNull();
    currentTime = 11_000;
    expect(store.get(id)).toBeNull();
    expect(key.every((byte) => byte === 0)).toBe(true);
  });

  it('revokes one session, revokes all sessions, and sweeps expired entries', () => {
    let currentTime = 1_000;
    const store = new SessionStore({ now: () => currentTime, idleTimeoutMs: 5_000 });
    stores.push(store);
    const firstKey = Buffer.alloc(32, 3);
    const secondKey = Buffer.alloc(32, 4);
    const firstId = store.create(firstKey);
    const secondId = store.create(secondKey);

    expect(store.revoke(firstId)).toBe(true);
    expect(store.get(firstId)).toBeNull();
    expect(firstKey.every((byte) => byte === 0)).toBe(true);

    currentTime = 7_000;
    expect(store.sweep()).toBe(1);
    expect(store.get(secondId)).toBeNull();
    expect(secondKey.every((byte) => byte === 0)).toBe(true);

    const thirdKey = Buffer.alloc(32, 5);
    store.create(thirdKey);
    expect(store.revokeAll()).toBe(1);
    expect(thirdKey.every((byte) => byte === 0)).toBe(true);
  });

  it('tracks active connections without making an expired key reusable', () => {
    let currentTime = 100;
    const store = new SessionStore({ now: () => currentTime, idleTimeoutMs: 10 });
    stores.push(store);
    const id = store.create(Buffer.alloc(32, 9));

    expect(store.addConnection(id)).toBe(true);
    expect(store.get(id)?.activeConnections).toBe(1);
    expect(store.removeConnection(id)).toBe(true);
    expect(store.get(id)?.activeConnections).toBe(0);

    currentTime = 111;
    expect(store.get(id)).toBeNull();
    expect(store.addConnection(id)).toBe(false);
  });
});
