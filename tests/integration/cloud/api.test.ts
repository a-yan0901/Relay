import { afterEach, describe, expect, it } from 'vitest';

import { buildCloudApp, type CloudAuthApi, type CloudSnapshotApi } from '../../../src/cloud/app.js';
import { loadCloudConfig } from '../../../src/cloud/config.js';
import type { AccountSession, DeviceDescriptor } from '../../../src/shared/core/models.js';
import type { CloudDataEnvelope } from '../../../src/shared/cloud/protocol.js';
import type { CloudSnapshotHead } from '../../../src/cloud/snapshot-repository.js';

const session: AccountSession = {
  accountId: 'account-1',
  deviceId: 'device-1',
  state: 'signed-in',
  expiresAt: '2026-09-18T00:00:00.000Z'
};

const head: CloudSnapshotHead = {
  domain: 'account-data',
  resourceId: 'account-1',
  revision: 1,
  payloadHash: 'a'.repeat(64),
  keyVersion: 1,
  updatedAt: '2026-09-17T00:00:00.000Z'
};

const envelope: CloudDataEnvelope = {
  protocolVersion: 1,
  domain: 'account-data',
  accountId: 'account-1',
  revision: 1,
  parentRevision: null,
  writerDeviceId: 'device-1',
  keyVersion: 1,
  nonce: 'nonce',
  ciphertext: 'ciphertext',
  authTag: 'tag',
  aad: 'aad',
  payloadHash: 'a'.repeat(64),
  byteLength: 12
};

const config = loadCloudConfig({
  NODE_ENV: 'test',
  MYSQL_DATABASE: 'relay_test',
  MYSQL_USER: 'relay',
  MYSQL_PASSWORD: 'secret'
});
const validToken = 'a'.repeat(43);

const createAuth = (): CloudAuthApi => ({
  async register() { return { account: session, token: 'token' }; },
  async signIn() { return { account: session, token: 'token' }; },
  async authenticate(token) { return token === validToken ? session : null; },
  async signOut() {},
  async listDevices(): Promise<readonly DeviceDescriptor[]> { return []; },
  async revokeDevice() {}
});

const createSnapshots = (): CloudSnapshotApi => ({
  async getHead() { return head; },
  async getRevision() { return envelope; },
  async put() { return head; }
});

describe('cloud API', () => {
  const apps: Array<Awaited<ReturnType<typeof buildCloudApp>>> = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
  });

  it('requires bearer authentication for account data', async () => {
    const app = await buildCloudApp({ config, auth: createAuth(), snapshots: createSnapshots() });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/v2/account-data/head' });

    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('ACCOUNT_SESSION_INVALID');
  });

  it('returns the account head and accepts only the current device as writer', async () => {
    const app = await buildCloudApp({ config, auth: createAuth(), snapshots: createSnapshots() });
    apps.push(app);

    const headResponse = await app.inject({
      method: 'GET',
      url: '/v2/account-data/head',
      headers: { authorization: `Bearer ${validToken}` }
    });
    expect(headResponse.statusCode).toBe(200);
    expect(headResponse.json()).toEqual(head);

    const invalidWriter = await app.inject({
      method: 'PUT',
      url: '/v2/account-data/snapshot',
      headers: { authorization: `Bearer ${validToken}`, 'idempotency-key': 'request-1' },
      payload: { ...envelope, writerDeviceId: 'device-other' }
    });
    expect(invalidWriter.statusCode).toBe(403);
    expect(invalidWriter.json().error.code).toBe('ACCOUNT_DEVICE_REVOKED');
  });
});
