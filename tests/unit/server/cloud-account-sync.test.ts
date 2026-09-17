import { describe, expect, it } from 'vitest';

import { generateCloudDeviceKeyPair } from '../../../src/shared/cloud/key-crypto.js';
import { CloudKeyManager } from '../../../src/shared/cloud/key-manager.js';
import { CloudSnapshotSyncEngine } from '../../../src/shared/cloud/sync.js';
import type { CloudSnapshotHead } from '../../../src/shared/cloud/client.js';
import type { CloudDataEnvelope, CloudDeviceDescriptor, CloudKeyGrant } from '../../../src/shared/cloud/protocol.js';
import { CloudAccountSyncCoordinator, type CloudAccountSnapshotPort } from '../../../src/server/cloud/cloud-account-sync.js';

const accountId = 'account-1';
const deviceId = 'device-web';

const createFixture = async () => {
  const keys = await generateCloudDeviceKeyPair();
  const device: CloudDeviceDescriptor = { id: deviceId, label: 'Web', platform: 'web', lastSeenAt: null, current: true, revokedAt: null, trustedAt: '2026-09-18T00:00:00.000Z', publicKey: keys.publicKey };
  const grants = new Map<string, CloudKeyGrant>();
  let envelope: CloudDataEnvelope | null = null;
  let head: CloudSnapshotHead | null = null;
  let local = new TextEncoder().encode('empty');
  const api = {
    async listDevices() { return [device]; },
    async listAccountDataKeys() { return [...grants.values()]; },
    async putAccountDataKey(_token: string, recipientDeviceId: string, input: { keyVersion: number; wrappedKey: Record<string, unknown> }) {
      const grant: CloudKeyGrant = { protocolVersion: 1, domain: 'account-data', accountId, resourceId: accountId, recipientDeviceId, keyVersion: input.keyVersion, wrappedKey: input.wrappedKey, createdAt: '2026-09-18T00:00:00.000Z', revokedAt: null };
      grants.set(`${recipientDeviceId}:${input.keyVersion}`, grant);
      return grant;
    },
    async listWorkspaceKeys() { return []; },
    async putWorkspaceKey() { throw new Error('not used'); },
    async getAccountDataHead() { return head; },
    async getAccountDataSnapshot() { if (!envelope) throw new Error('missing snapshot'); return envelope; },
    async putAccountDataSnapshot(_token: string, next: CloudDataEnvelope) {
      envelope = next;
      head = { domain: 'account-data', resourceId: accountId, revision: next.revision, payloadHash: next.payloadHash, keyVersion: next.keyVersion, updatedAt: '2026-09-18T00:00:00.000Z' };
      return head;
    }
  };
  const snapshot: CloudAccountSnapshotPort = {
    async create() { return new Uint8Array(local); },
    isEmpty(value) { return new TextDecoder().decode(value) === 'empty'; },
    async apply(_vaultKey, value) { local = new Uint8Array(value); }
  };
  const context = (cursor: Parameters<CloudAccountSyncCoordinator['run']>[0]['cursor']) => ({ token: 't'.repeat(43), accountId, deviceId, deviceKeyPair: keys, vaultKey: Buffer.alloc(32, 9), cursor });
  return { api, snapshot, context, keys, getLocal: () => new TextDecoder().decode(local), getHead: () => head, getEnvelope: () => envelope };
};

describe('cloud account sync coordinator', () => {
  it('initializes, then publishes a local-only change with a CAS parent', async () => {
    const fixture = await createFixture();
    const coordinator = new CloudAccountSyncCoordinator(fixture.api, fixture.snapshot);
    const first = await coordinator.run(fixture.context(null));
    expect(first.status).toBe('initialized');
    expect(first.cursor?.remoteRevision).toBe(1);

    const originalCreate = fixture.snapshot.create;
    fixture.snapshot.create = async (key) => {
      await originalCreate(key);
      return new TextEncoder().encode('changed');
    };
    const second = await coordinator.run(fixture.context(first.cursor));
    expect(second.status).toBe('pushed');
    expect(second.cursor?.remoteRevision).toBe(2);
    expect(fixture.getEnvelope()?.parentRevision).toBe(1);
  });

  it('pulls remote data on a first login only when the local account snapshot is empty', async () => {
    const fixture = await createFixture();
    const coordinator = new CloudAccountSyncCoordinator(fixture.api, fixture.snapshot);
    const first = await coordinator.run(fixture.context(null));
    expect(first.status).toBe('initialized');

    const remoteSnapshot = { ...fixture.snapshot, async create() { return new TextEncoder().encode('remote'); }, isEmpty: () => false } satisfies CloudAccountSnapshotPort;
    const remoteCoordinator = new CloudAccountSyncCoordinator(fixture.api, remoteSnapshot);
    const pushed = await remoteCoordinator.run(fixture.context(first.cursor));
    expect(pushed.status).toBe('pushed');

    const emptySnapshot: CloudAccountSnapshotPort = {
      async create() { return new TextEncoder().encode('empty'); },
      isEmpty: () => true,
      async apply(_key, value) { expect(new TextDecoder().decode(value)).toBe('remote'); }
    };
    const pullCoordinator = new CloudAccountSyncCoordinator(fixture.api, emptySnapshot);
    const pulled = await pullCoordinator.run(fixture.context(null));
    expect(pulled.status).toBe('pulled');
  });

  it('returns a conflict when both sides changed after the last cursor', async () => {
    const fixture = await createFixture();
    const coordinator = new CloudAccountSyncCoordinator(fixture.api, fixture.snapshot);
    const first = await coordinator.run(fixture.context(null));

    const remoteKeys = new CloudKeyManager(fixture.api, { token: 't'.repeat(43), accountId, deviceId, deviceKeyPair: fixture.keys });
    const material = await remoteKeys.getAccountDataKey();
    const remoteEngine = new CloudSnapshotSyncEngine(fixture.api);
    await remoteEngine.publish({ domain: 'account-data', accountId, token: 't'.repeat(43), writerDeviceId: deviceId, keyVersion: material.keyVersion, parentRevision: first.cursor?.remoteRevision ?? null, plaintext: new TextEncoder().encode('remote-change'), dataKey: material.key, idempotencyKey: 'remote-change' });
    material.key.fill(0);

    const changedLocal: CloudAccountSnapshotPort = {
      async create() { return new TextEncoder().encode('local-change'); },
      isEmpty: () => false,
      async apply() { throw new Error('must not apply during conflict'); }
    };
    const result = await new CloudAccountSyncCoordinator(fixture.api, changedLocal).run(fixture.context(first.cursor));
    expect(result.status).toBe('conflict');
    expect(result.cursor).toEqual(first.cursor);
  });
});
