import { describe, expect, it } from 'vitest';

import {
  assertCloudRevisionChain,
  assertCloudIdempotentReplay,
  hashCloudIdempotencyKey,
  type CloudRevisionInput
} from '../../../src/cloud/snapshot-repository.js';

describe('cloud snapshot CAS', () => {
  it('accepts the first revision and the next child revision', () => {
    const first: CloudRevisionInput = { revision: 1, parentRevision: null };
    const second: CloudRevisionInput = { revision: 2, parentRevision: 1 };

    expect(assertCloudRevisionChain(null, first)).toBe(1);
    expect(assertCloudRevisionChain(1, second)).toBe(2);
  });

  it('rejects a stale parent or a revision jump without overwriting the head', () => {
    expect(() => assertCloudRevisionChain(2, { revision: 3, parentRevision: 1 })).toThrowError(expect.objectContaining({ code: 'SYNC_CONFLICT' }));
    expect(() => assertCloudRevisionChain(2, { revision: 4, parentRevision: 2 })).toThrowError(expect.objectContaining({ code: 'SYNC_CONFLICT' }));
    expect(() => assertCloudRevisionChain(null, { revision: 2, parentRevision: null })).toThrowError(expect.objectContaining({ code: 'SYNC_CONFLICT' }));
  });

  it('hashes idempotency keys before they can be persisted', () => {
    const hashed = hashCloudIdempotencyKey('request-1');

    expect(hashed).toHaveLength(64);
    expect(hashed).toMatch(/^[a-f0-9]+$/u);
    expect(hashed).not.toContain('request-1');
    expect(hashCloudIdempotencyKey('request-1')).toBe(hashed);
  });

  it('only treats an idempotency key as a replay when the complete envelope matches', () => {
    const envelope = {
      revision: 2,
      parentRevision: 1,
      writerDeviceId: 'device-1',
      keyVersion: 1,
      nonce: 'nonce-2',
      ciphertext: 'ciphertext-2',
      authTag: 'tag-2',
      aad: 'aad-2',
      payloadHash: 'b'.repeat(64),
      byteLength: 12
    };
    expect(() => assertCloudIdempotentReplay(envelope, envelope)).not.toThrow();
    expect(() => assertCloudIdempotentReplay(envelope, { ...envelope, ciphertext: 'different' })).toThrowError(expect.objectContaining({ code: 'SYNC_CONFLICT' }));
  });
});
