import { afterEach, describe, expect, it } from 'vitest';

import { buildCloudApp, type CloudAuthApi, type CloudKeyApi, type CloudSnapshotApi, type CloudWorkspaceApi } from '../../../src/cloud/app.js';
import { loadCloudConfig } from '../../../src/cloud/config.js';
import type { AccountSession, DeviceDescriptor } from '../../../src/shared/core/models.js';
import type { CloudDataEnvelope, CloudKeyGrant } from '../../../src/shared/cloud/protocol.js';
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

const denyWorkspaces: CloudWorkspaceApi = {
  async list() { return []; },
  async canOwn() { return false; },
  async canView() { return false; }
};

const keyGrant: CloudKeyGrant = {
  protocolVersion: 1,
  domain: 'account-data',
  accountId: 'account-1',
  resourceId: 'account-1',
  recipientDeviceId: 'device-1',
  keyVersion: 1,
  wrappedKey: { scheme: 'test', ciphertext: 'wrapped' },
  createdAt: '2026-09-17T00:00:00.000Z',
  revokedAt: null
};

const createKeys = (): CloudKeyApi => ({
  async listAccountDataKeys() { return [keyGrant]; },
  async putAccountDataKey(input, now) { return { ...input, createdAt: now, revokedAt: null }; },
  async listWorkspaceKeys() { return []; },
  async putWorkspaceKey(input, now) { return { ...input, createdAt: now, revokedAt: null }; }
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

  it('returns the authenticated account session without exposing the bearer token', async () => {
    const app = await buildCloudApp({ config, auth: createAuth(), snapshots: createSnapshots() });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/v2/auth/session',
      headers: { authorization: `Bearer ${validToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ account: session });
    expect(response.body).not.toContain(validToken);
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

  it('rejects workspace snapshot access when the authenticated device is not a member', async () => {
    const app = await buildCloudApp({ config, auth: createAuth(), snapshots: createSnapshots(), workspaces: denyWorkspaces });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/v2/workspaces/workspace-1/head',
      headers: { authorization: `Bearer ${validToken}` }
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().error.code).toBe('ACCOUNT_DEVICE_REVOKED');
  });

  it('scopes account key grants to the authenticated device and recipient path', async () => {
    const app = await buildCloudApp({ config, auth: createAuth(), snapshots: createSnapshots(), keys: createKeys() });
    apps.push(app);

    const list = await app.inject({
      method: 'GET',
      url: '/v2/account-data/keys',
      headers: { authorization: `Bearer ${validToken}` }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toEqual([keyGrant]);

    const put = await app.inject({
      method: 'PUT',
      url: '/v2/account-data/keys/device-2',
      headers: { authorization: `Bearer ${validToken}` },
      payload: { keyVersion: 1, wrappedKey: { scheme: 'test', ciphertext: 'wrapped-2' } }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json()).toMatchObject({
      accountId: 'account-1',
      resourceId: 'account-1',
      recipientDeviceId: 'device-2',
      wrappedKey: { ciphertext: 'wrapped-2' }
    });
  });
});
