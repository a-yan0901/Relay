import { describe, expect, it } from 'vitest';

import { generateCloudDeviceKeyPair } from '../../../src/shared/cloud/key-crypto.js';
import { CloudKeyManager } from '../../../src/shared/cloud/key-manager.js';
import type { CloudDeviceDescriptor, CloudKeyGrant } from '../../../src/shared/cloud/protocol.js';

describe('cloud key manager', () => {
  it('bootstraps an account key and grants the same key to another device', async () => {
    const ownerKeys = await generateCloudDeviceKeyPair();
    const targetKeys = await generateCloudDeviceKeyPair();
    const grants = new Map<string, CloudKeyGrant>();
    const devices: CloudDeviceDescriptor[] = [
      { id: 'device-owner', label: 'Owner', platform: 'web', lastSeenAt: null, current: true, revokedAt: null, publicKey: ownerKeys.publicKey },
      { id: 'device-target', label: 'Target', platform: 'android', lastSeenAt: null, current: false, revokedAt: null, publicKey: targetKeys.publicKey }
    ];
    const api = {
      async listDevices() { return devices; },
      async listAccountDataKeys(_token: string) { return [...grants.values()]; },
      async putAccountDataKey(_token: string, recipientDeviceId: string, input: { keyVersion: number; wrappedKey: Record<string, unknown> }) {
        const grant: CloudKeyGrant = { protocolVersion: 1, domain: 'account-data', accountId: 'account-1', resourceId: 'account-1', recipientDeviceId, keyVersion: input.keyVersion, wrappedKey: input.wrappedKey, createdAt: '2026-09-18T00:00:00.000Z', revokedAt: null };
        grants.set(`${recipientDeviceId}:${input.keyVersion}`, grant);
        return grant;
      },
      async listWorkspaceKeys() { return []; },
      async putWorkspaceKey() { throw new Error('not used'); }
    };
    const owner = new CloudKeyManager(api, { token: 'token', accountId: 'account-1', deviceId: 'device-owner', deviceKeyPair: ownerKeys });
    const ownerKey = await owner.ensureAccountDataKey();
    await owner.grantAccountDataKey('device-target');
    const target = new CloudKeyManager(api, { token: 'token', accountId: 'account-1', deviceId: 'device-target', deviceKeyPair: targetKeys });

    await expect(target.getAccountDataKey()).resolves.toEqual(ownerKey);
  });

  it('does not allocate a new key when bootstrap is disabled and no grant exists', async () => {
    const keys = await generateCloudDeviceKeyPair();
    const api = {
      async listDevices() { return []; },
      async listAccountDataKeys() { return []; },
      async putAccountDataKey() { throw new Error('must not put'); },
      async listWorkspaceKeys() { return []; },
      async putWorkspaceKey() { throw new Error('must not put'); }
    };
    const manager = new CloudKeyManager(api, { token: 'token', accountId: 'account-1', deviceId: 'device-1', deviceKeyPair: keys });
    await expect(manager.getAccountDataKey()).rejects.toMatchObject({ code: 'SYNC_NOT_FOUND' });
  });
});
