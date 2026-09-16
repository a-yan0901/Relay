import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import type { SyncConflictExport } from '../../../src/shared/core/models.js';
import {
  parseSyncConflictExport,
  serializeSyncConflictExport,
  SYNC_CONFLICT_EXPORT_KDF,
  SYNC_CONFLICT_EXPORT_MAX_BYTES
} from '../../../src/shared/core/sync-conflict-export.js';

const base64 = (length: number): string => Buffer.alloc(length).toString('base64');

const envelope = (aad: string, ciphertext = base64(32)) => ({
  version: 1 as const,
  nonce: base64(12),
  ciphertext,
  authTag: base64(16),
  aad
});

const createPackage = (): SyncConflictExport => ({
  format: 'relay-sync-conflict',
  version: 1,
  conflictId: 'conflict-1',
  createdAt: '2026-09-17T10:00:00.000Z',
  copies: [
    {
      copy: 'local',
      revision: 3,
      payloadHash: 'a'.repeat(64),
      kdf: { ...SYNC_CONFLICT_EXPORT_KDF, salt: base64(16) },
      wrappedBundleKey: envelope(Buffer.from('relay-sync-conflict:v1:conflict-1:local').toString('base64')),
      payload: envelope(Buffer.from('relay-sync-conflict:v1:conflict-1:local').toString('base64'))
    },
    {
      copy: 'remote',
      revision: 4,
      payloadHash: 'b'.repeat(64),
      kdf: { ...SYNC_CONFLICT_EXPORT_KDF, salt: base64(16) },
      wrappedBundleKey: envelope(Buffer.from('relay-sync-conflict:v1:conflict-1:remote').toString('base64')),
      payload: envelope(Buffer.from('relay-sync-conflict:v1:conflict-1:remote').toString('base64'))
    }
  ]
});

const expectPayloadInvalid = (value: unknown): void => {
  try {
    parseSyncConflictExport(value);
    throw new Error('expected parser to reject value');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('SYNC_PAYLOAD_INVALID');
  }
};

describe('shared encrypted sync conflict export contract', () => {
  it('parses and serializes an exact two-copy package', () => {
    const value = createPackage();

    expect(parseSyncConflictExport(JSON.parse(serializeSyncConflictExport(value)))).toEqual(value);
    expect(serializeSyncConflictExport(value).length).toBeLessThan(SYNC_CONFLICT_EXPORT_MAX_BYTES);
  });

  it('requires exactly one local and one remote copy', () => {
    const value = createPackage();

    expectPayloadInvalid({ ...value, copies: [value.copies[0], value.copies[0]] });
    expectPayloadInvalid({ ...value, copies: [value.copies[0]] });
    expectPayloadInvalid({ ...value, copies: [...value.copies, value.copies[1]] });
  });

  it('accepts an empty payload ciphertext at the lower bound', () => {
    const value = createPackage();
    const emptyPayload = { ...value.copies[0].payload, ciphertext: '' };

    expect(parseSyncConflictExport({
      ...value,
      copies: [{ ...value.copies[0], payload: emptyPayload }, value.copies[1]]
    }).copies[0].payload.ciphertext).toBe('');
  });

  it('rejects unknown keys, invalid KDF parameters, malformed base64, and plaintext fields', () => {
    const value = createPackage();

    expectPayloadInvalid({ ...value, unexpected: 'host marker' });
    expectPayloadInvalid({
      ...value,
      copies: [{ ...value.copies[0], kdf: { ...value.copies[0].kdf, timeCost: 99 } }, value.copies[1]]
    });
    expectPayloadInvalid({
      ...value,
      copies: [{ ...value.copies[0], payload: { ...value.copies[0].payload, plaintext: 'secret command' } }, value.copies[1]]
    });
    expectPayloadInvalid({
      ...value,
      copies: [{ ...value.copies[0], payload: { ...value.copies[0].payload, nonce: 'not-base64' } }, value.copies[1]]
    });
  });

  it('rejects unsafe identifiers, invalid dates, hashes, and oversized payloads', () => {
    const value = createPackage();

    expectPayloadInvalid({ ...value, conflictId: '../secrets' });
    expectPayloadInvalid({ ...value, createdAt: 'not-a-date' });
    expectPayloadInvalid({
      ...value,
      copies: [{ ...value.copies[0], payloadHash: 'not-a-hash' }, value.copies[1]]
    });
    expectPayloadInvalid({
      ...value,
      copies: [{ ...value.copies[0], payload: envelope(value.copies[0].payload.aad, Buffer.alloc(32 * 1024 * 1024 + 1).toString('base64')) }, value.copies[1]]
    });
  });
});
