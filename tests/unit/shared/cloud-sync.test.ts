import { describe, expect, it } from 'vitest';

import { CloudSnapshotSyncEngine } from '../../../src/shared/cloud/sync.js';
import type { CloudSnapshotHead } from '../../../src/shared/cloud/client.js';
import type { CloudDataEnvelope } from '../../../src/shared/cloud/protocol.js';

const head: CloudSnapshotHead = {
  domain: 'account-data',
  resourceId: 'account-1',
  revision: 1,
  payloadHash: 'a'.repeat(64),
  keyVersion: 1,
  updatedAt: '2026-09-18T00:00:00.000Z'
};

describe('bounded cloud snapshot sync engine', () => {
  it('encrypts and publishes one account snapshot without retaining a local queue', async () => {
    let stored: CloudDataEnvelope | null = null;
    let currentHead: CloudSnapshotHead | null = null;
    const api = {
      async getAccountDataHead() { return currentHead; },
      async putAccountDataSnapshot(_token: string, envelope: CloudDataEnvelope) {
        stored = envelope;
        currentHead = { ...head, revision: envelope.revision, payloadHash: envelope.payloadHash };
        return currentHead;
      },
      async getAccountDataSnapshot() { if (!stored) throw new Error('missing'); return stored; }
    };
    const engine = new CloudSnapshotSyncEngine(api, { maxPlaintextBytes: 1024 });
    const plaintext = new TextEncoder().encode('{"hosts":[]}');
    const dataKey = new Uint8Array(32).fill(4);
    await expect(engine.publish({ token: 'token', domain: 'account-data', accountId: 'account-1', writerDeviceId: 'device-1', keyVersion: 1, parentRevision: null, plaintext, dataKey, idempotencyKey: 'request-1' })).resolves.toMatchObject({ revision: 1 });
    expect(stored?.ciphertext).toBeTruthy();
    expect(JSON.stringify(stored)).not.toContain('{"hosts":[]}');
    await expect(engine.pull({ token: 'token', domain: 'account-data', accountId: 'account-1', dataKey })).resolves.toMatchObject({ head: expect.objectContaining({ revision: 1 }), plaintext });
  });

  it('rejects an oversized snapshot before crypto allocation', async () => {
    const engine = new CloudSnapshotSyncEngine({
      async getAccountDataHead() { return null; },
      async putAccountDataSnapshot() { throw new Error('must not publish'); },
      async getAccountDataSnapshot() { throw new Error('not used'); }
    }, { maxPlaintextBytes: 8 });
    await expect(engine.publish({ token: 'token', domain: 'account-data', accountId: 'account-1', writerDeviceId: 'device-1', keyVersion: 1, parentRevision: null, plaintext: new Uint8Array(9), dataKey: new Uint8Array(32), idempotencyKey: 'request-1' })).rejects.toThrow('cloud snapshot too large');
  });
});
