import { describe, expect, it } from 'vitest';

import {
  CloudAuthService,
  type CloudAuthRepositoryPort
} from '../../../src/cloud/auth-service.js';
import type { CloudAccountRecord, CloudDeviceRecord, CloudSessionRecord } from '../../../src/cloud/account-repository.js';

const createRepository = (): CloudAuthRepositoryPort & { sessions: Map<string, CloudSessionRecord>; devices: Map<string, CloudDeviceRecord> } => {
  const accounts = new Map<string, CloudAccountRecord>();
  const devices = new Map<string, CloudDeviceRecord>();
  const sessions = new Map<string, CloudSessionRecord>();
  return {
    accounts,
    devices,
    sessions,
    async getAccountByEmail(email) {
      return [...accounts.values()].find((account) => account.email === email) ?? null;
    },
    async createAccountWithDevice(account, device) {
      accounts.set(account.id, { id: account.id, email: account.email, passwordHash: account.passwordHash, createdAt: account.createdAt, updatedAt: account.createdAt });
      devices.set(device.id, { id: device.id, accountId: device.accountId, label: device.label, platform: device.platform, trustedAt: device.trustedAt ?? null, createdAt: device.createdAt, lastSeenAt: null, revokedAt: null });
    },
    async createDevice(input) {
      devices.set(input.id, { id: input.id, accountId: input.accountId, label: input.label, platform: input.platform, trustedAt: input.trustedAt ?? null, createdAt: input.createdAt, lastSeenAt: null, revokedAt: null });
    },
    async getDevice(accountId, deviceId) {
      const device = devices.get(deviceId);
      return device?.accountId === accountId ? device : null;
    },
    async createSession(input) {
      sessions.set(input.tokenHash, { ...input, lastUsedAt: input.createdAt, revokedAt: null });
    },
    async getSession(tokenHash) {
      return sessions.get(tokenHash) ?? null;
    },
    async touchSession(tokenHash, at) {
      const session = sessions.get(tokenHash);
      if (session) sessions.set(tokenHash, { ...session, lastUsedAt: at });
    },
    async revokeSession(tokenHash, at) {
      const session = sessions.get(tokenHash);
      if (session) sessions.set(tokenHash, { ...session, revokedAt: at });
    },
    async revokeDevice(accountId, deviceId, at) {
      const device = devices.get(deviceId);
      if (!device || device.accountId !== accountId || device.revokedAt !== null) return false;
      devices.set(deviceId, { ...device, revokedAt: at });
      return true;
    },
    async revokeDeviceSessions(accountId, deviceId, at) {
      for (const [tokenHash, session] of sessions) {
        if (session.accountId === accountId && session.deviceId === deviceId) sessions.set(tokenHash, { ...session, revokedAt: at });
      }
    },
    async trustDevice(accountId, deviceId, at) {
      const device = devices.get(deviceId);
      if (!device || device.accountId !== accountId || device.revokedAt !== null || device.trustedAt !== null) return false;
      devices.set(deviceId, { ...device, trustedAt: at });
      return true;
    }
  };
};

describe('cloud auth service', () => {
  it('registers a device and returns an opaque session token separately from the account DTO', async () => {
    const repository = createRepository();
    const service = new CloudAuthService(repository, { idleTimeoutMs: 60_000, absoluteTimeoutMs: 3_600_000 }, () => 1_700_000_000_000);

    const result = await service.register(' User@example.com ', 'password-123', { platform: 'web', label: 'Browser' });

    expect(result.account.state).toBe('signed-in');
    expect(result.account.accountId).toBeTruthy();
    expect(result.token.length).toBeGreaterThanOrEqual(43);
    expect(JSON.stringify(result.account)).not.toContain(result.token);
    expect(repository.devices.size).toBe(1);
    expect(repository.sessions.size).toBe(1);
  });

  it('rejects authentication after the device has been revoked', async () => {
    const repository = createRepository();
    const service = new CloudAuthService(repository, { idleTimeoutMs: 60_000, absoluteTimeoutMs: 3_600_000 }, () => 1_700_000_000_000);
    const result = await service.register('user@example.com', 'password-123', { platform: 'android' });
    const [deviceId] = repository.devices.keys();
    const device = repository.devices.get(deviceId);
    if (!device) throw new Error('test device missing');
    repository.devices.set(deviceId, { ...device, revokedAt: new Date(1_700_000_001_000).toISOString() });

    await expect(service.authenticate(result.token)).rejects.toMatchObject({ code: 'ACCOUNT_SESSION_INVALID' });
  });

  it('requires explicit approval before a newly signed-in device becomes trusted', async () => {
    const repository = createRepository();
    const service = new CloudAuthService(repository, { idleTimeoutMs: 60_000, absoluteTimeoutMs: 3_600_000 }, () => 1_700_000_000_000);
    const owner = await service.register('user@example.com', 'password-123', { platform: 'web' });
    const pending = await service.signIn('user@example.com', 'password-123', { platform: 'android' });

    expect(owner.account.trusted).toBe(true);
    expect(pending.account.trusted).toBe(false);
    expect((await service.authenticate(pending.token)).trusted).toBe(false);

    await service.trustDevice(owner.token, pending.account.deviceId);
    expect((await service.authenticate(pending.token)).trusted).toBe(true);
  });

  it('rotates a session token and invalidates the previous token', async () => {
    const repository = createRepository();
    const service = new CloudAuthService(repository, { idleTimeoutMs: 60_000, absoluteTimeoutMs: 3_600_000 }, () => 1_700_000_000_000);
    const issued = await service.register('user@example.com', 'password-123', { platform: 'desktop' });

    const refreshed = await service.refresh(issued.token);

    expect(refreshed.token).not.toBe(issued.token);
    await expect(service.authenticate(issued.token)).rejects.toMatchObject({ code: 'ACCOUNT_SESSION_INVALID' });
    await expect(service.authenticate(refreshed.token)).resolves.toMatchObject({
      accountId: issued.account.accountId,
      deviceId: issued.account.deviceId,
      trusted: true
    });
  });
});
