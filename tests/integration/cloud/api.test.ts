import { afterEach, describe, expect, it } from 'vitest';

import { buildCloudApp, type CloudAuthApi, type CloudKeyApi, type CloudSnapshotApi, type CloudWorkspaceApi } from '../../../src/cloud/app.js';
import { loadCloudConfig } from '../../../src/cloud/config.js';
import type { AccountSession, DeviceDescriptor } from '../../../src/shared/core/models.js';
import { createCloudDataAad, type CloudDataEnvelope, type CloudKeyGrant } from '../../../src/shared/cloud/protocol.js';
import type { CloudSnapshotHead } from '../../../src/cloud/snapshot-repository.js';
import type { CloudWorkspaceDescriptor } from '../../../src/cloud/workspace-repository.js';

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
  aad: createCloudDataAad({ domain: 'account-data', accountId: 'account-1', revision: 1, parentRevision: null, keyVersion: 1, writerDeviceId: 'device-1' }),
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

const workspace: CloudWorkspaceDescriptor = {
  id: 'workspace-1',
  accountId: 'account-1',
  ownerDeviceId: 'device-1',
  encryptedTitle: 'relay-title',
  createdAt: '2026-09-17T00:00:00.000Z',
  updatedAt: '2026-09-17T00:00:00.000Z',
  deletedAt: null
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
      payload: {
        ...envelope,
        writerDeviceId: 'device-other',
        aad: createCloudDataAad({ domain: 'account-data', accountId: 'account-1', revision: 1, parentRevision: null, keyVersion: 1, writerDeviceId: 'device-other' })
      }
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

  it('serves browser CORS only for configured trusted origins', async () => {
    const app = await buildCloudApp({
      config: { ...config, trustedOrigins: ['https://app.example.test'] },
      auth: createAuth(),
      snapshots: createSnapshots()
    });
    apps.push(app);

    const allowed = await app.inject({
      method: 'OPTIONS',
      url: '/v2/auth/session',
      headers: {
        origin: 'https://app.example.test',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization'
      }
    });
    expect(allowed.statusCode).toBe(204);
    expect(allowed.headers['access-control-allow-origin']).toBe('https://app.example.test');
    expect(allowed.headers.vary).toContain('Origin');

    const denied = await app.inject({
      method: 'OPTIONS',
      url: '/v2/auth/session',
      headers: { origin: 'https://evil.example.test', 'access-control-request-method': 'GET' }
    });
    expect(denied.statusCode).toBe(403);
  });

  it('adds bounded ephemeral presence to workspace directory data', async () => {
    const workspaces: CloudWorkspaceApi = {
      async list() { return [workspace]; },
      async canOwn() { return true; },
      async canView() { return true; }
    };
    const app = await buildCloudApp({ config, auth: createAuth(), snapshots: createSnapshots(), workspaces });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/v2/workspaces',
      headers: { authorization: `Bearer ${validToken}` }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ ...workspace, online: false, activeViewerCount: 0 }]);
  });
});
