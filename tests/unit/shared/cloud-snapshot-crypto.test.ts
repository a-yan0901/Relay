import { describe, expect, it } from 'vitest';

import { decryptCloudSnapshot, encryptCloudSnapshot } from '../../../src/shared/cloud/snapshot-crypto.js';

describe('cloud snapshot encryption', () => {
  it('binds encrypted data to revision metadata and verifies its hash', async () => {
    const plaintext = new TextEncoder().encode('{"hosts":[]}');
    const envelope = await encryptCloudSnapshot({
      domain: 'account-data',
      accountId: 'account-1',
      revision: 2,
      parentRevision: 1,
      keyVersion: 1,
      writerDeviceId: 'device-1',
      dataKey: new Uint8Array(32).fill(4),
      plaintext
    });

    expect(envelope.ciphertext).not.toContain('{"hosts":[]}');
    await expect(decryptCloudSnapshot(envelope, new Uint8Array(32).fill(4))).resolves.toEqual(plaintext);
    await expect(decryptCloudSnapshot({ ...envelope, revision: 3, aad: envelope.aad }, new Uint8Array(32).fill(4))).rejects.toThrow();
  });

  it('rejects an altered encrypted payload', async () => {
    const envelope = await encryptCloudSnapshot({
      domain: 'workspace',
      accountId: 'account-1',
      workspaceId: 'workspace-1',
      revision: 1,
      parentRevision: null,
      keyVersion: 1,
      writerDeviceId: 'device-1',
      dataKey: new Uint8Array(32).fill(8),
      plaintext: new Uint8Array([1, 2, 3])
    });
    const altered = `${envelope.ciphertext.slice(0, -1)}${envelope.ciphertext.endsWith('A') ? 'B' : 'A'}`;
    await expect(decryptCloudSnapshot({ ...envelope, ciphertext: altered }, new Uint8Array(32).fill(8))).rejects.toThrow();
  });
});
