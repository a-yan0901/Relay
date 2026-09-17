import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { buildCloudApp, type CloudAuthApi, type CloudRelayAuthorization, type CloudSnapshotApi } from '../../../src/cloud/app.js';
import { loadCloudConfig } from '../../../src/cloud/config.js';
import type { AccountSession, DeviceDescriptor } from '../../../src/shared/core/models.js';

const token = 'a'.repeat(43);
const viewerToken = 'b'.repeat(43);
const session: AccountSession = { accountId: 'account-1', deviceId: 'device-owner', state: 'signed-in', expiresAt: '2026-09-18T00:00:00.000Z' };
const config = loadCloudConfig({ NODE_ENV: 'test', MYSQL_DATABASE: 'relay_test', MYSQL_USER: 'relay', MYSQL_PASSWORD: 'secret' });

const auth: CloudAuthApi = {
  async register() { return { account: session, token }; },
  async signIn() { return { account: session, token }; },
  async authenticate(value) {
    if (value === token) return session;
    if (value === viewerToken) return { ...session, deviceId: 'device-viewer' };
    return null;
  },
  async signOut() {},
  async listDevices(): Promise<readonly DeviceDescriptor[]> { return []; },
  async revokeDevice() {}
};

const snapshots: CloudSnapshotApi = {
  async getHead() { return null; },
  async getRevision() { return null; },
  async put() { throw new Error('not used'); }
};

const authorization: CloudRelayAuthorization = {
  async canOwn() { return true; },
  async canView() { return true; }
};

const waitForOpen = (socket: WebSocket): Promise<void> => new Promise((resolve, reject) => {
  socket.once('open', () => resolve());
  socket.once('error', reject);
});

const waitForMessage = (socket: WebSocket): Promise<Buffer> => new Promise((resolve, reject) => {
  socket.once('message', (data) => resolve(Buffer.from(data as Buffer)));
  socket.once('error', reject);
});

describe('cloud relay API', () => {
  const apps: Array<Awaited<ReturnType<typeof buildCloudApp>>> = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const app of apps.splice(0)) await app.close();
  });

  it('forwards opaque frames between one owner and an authorized viewer', async () => {
    const app = await buildCloudApp({ config, auth, snapshots, relayAuthorization: authorization });
    apps.push(app);
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const owner = new WebSocket(`${address}/v2/relay/owner?workspaceId=workspace-1`, { headers: { authorization: `Bearer ${token}` } });
    const viewer = new WebSocket(`${address}/v2/relay/viewer?workspaceId=workspace-1`, { headers: { authorization: `Bearer ${viewerToken}` } });
    sockets.push(owner, viewer);
    await Promise.all([waitForOpen(owner), waitForOpen(viewer)]);

    const ownerInput = waitForMessage(owner);
    viewer.send(Buffer.from([1, 2]));
    expect([...await ownerInput]).toEqual([1, 2]);

    const viewerOutput = waitForMessage(viewer);
    owner.send(Buffer.from([3, 4]));
    expect([...await viewerOutput]).toEqual([3, 4]);
  });
});
