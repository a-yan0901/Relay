import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import {
  RECOVERY_KEY_VERSION,
  SYNC_KEY_VERSION,
  SYNC_MAX_PAYLOAD_BYTES,
  createRecoveryKey,
  createSyncKey,
  decryptSyncPayload,
  encryptSyncPayload,
  formatRecoveryKey,
  parseRecoveryKey,
  unwrapVaultKeyWithRecoveryKey,
  unwrapSyncKey,
  validateSyncEnvelope,
  wrapVaultKeyWithRecoveryKey,
  wrapSyncKey
} from '../../../src/server/sync/sync-crypto.js';

const vaultKey = () => randomBytes(32);

const expectAppError = (action: () => unknown, code: string): void => {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe(code);
  }
};

describe('sync crypto', () => {
  it('formats and parses a high-entropy recovery key without losing bytes', () => {
    const recoveryKey = createRecoveryKey();
    const formatted = formatRecoveryKey(recoveryKey);

    expect(recoveryKey).toHaveLength(32);
    expect(formatted).toMatch(/^RLY-RK1(?:-[A-Z2-7]{4})+$/u);
    expect(parseRecoveryKey(formatted)).toEqual(recoveryKey);
    expect(parseRecoveryKey(formatted.toLowerCase())).toEqual(recoveryKey);
  });

  it('wraps the Vault key with a recovery key and rejects wrong metadata or key', () => {
    const currentVaultKey = vaultKey();
    const recoveryKey = createRecoveryKey();
    const wrapped = wrapVaultKeyWithRecoveryKey(
      currentVaultKey,
      'vault-1',
      RECOVERY_KEY_VERSION,
      recoveryKey
    );

    expect(wrapped.ciphertext).not.toBe(currentVaultKey.toString('base64'));
    expect(unwrapVaultKeyWithRecoveryKey(recoveryKey, 'vault-1', RECOVERY_KEY_VERSION, wrapped)).toEqual(currentVaultKey);
    expectAppError(
      () => unwrapVaultKeyWithRecoveryKey(createRecoveryKey(), 'vault-1', RECOVERY_KEY_VERSION, wrapped),
      'VAULT_UNLOCK_FAILED'
    );
    expectAppError(
      () => unwrapVaultKeyWithRecoveryKey(recoveryKey, 'vault-2', RECOVERY_KEY_VERSION, wrapped),
      'VAULT_UNLOCK_FAILED'
    );
  });

  it('wraps and unwraps a random sync key with the Vault key', () => {
    const currentVaultKey = vaultKey();
    const syncKey = createSyncKey();
    const wrapped = wrapSyncKey(currentVaultKey, 'vault-1', SYNC_KEY_VERSION, syncKey);

    expect(syncKey).toHaveLength(32);
    expect(wrapped.ciphertext).not.toBe(syncKey.toString('base64'));
    expect(unwrapSyncKey(currentVaultKey, 'vault-1', SYNC_KEY_VERSION, wrapped)).toEqual(syncKey);
  });

  it('encrypts and decrypts a snapshot using revision-bound AAD', () => {
    const syncKey = createSyncKey();
    const plaintext = Buffer.from(JSON.stringify({
      hosts: [{ name: 'prod', password: 'not-for-the-cloud' }],
      command: 'cat privateKey',
      privateKey: 'not-for-the-cloud'
    }), 'utf8');
    const envelope = encryptSyncPayload({
      syncKey,
      vaultId: 'vault-1',
      revision: 7,
      parentRevision: 6,
      deviceId: 'device-1',
      keyVersion: SYNC_KEY_VERSION,
      plaintext
    });

    expect(JSON.stringify(envelope)).not.toContain('not-for-the-cloud');
    expect(JSON.stringify(envelope)).not.toContain('cat privateKey');
    expect(decryptSyncPayload(syncKey, envelope)).toEqual(plaintext);
    expect(envelope.aad).not.toBe('');
    expect(envelope.payloadHash).toHaveLength(64);
  });

  it('rejects changed AAD, ciphertext, auth tag and payload hash', () => {
    const syncKey = createSyncKey();
    const envelope = encryptSyncPayload({
      syncKey,
      vaultId: 'vault-1',
      revision: 1,
      parentRevision: null,
      deviceId: 'device-1',
      keyVersion: SYNC_KEY_VERSION,
      plaintext: Buffer.from('snapshot', 'utf8')
    });

    expectAppError(() => decryptSyncPayload(syncKey, { ...envelope, aad: Buffer.from('changed aad', 'utf8').toString('base64') }), 'SYNC_PAYLOAD_INVALID');
    expectAppError(() => decryptSyncPayload(syncKey, { ...envelope, ciphertext: Buffer.alloc(envelope.byteLength, 0x01).toString('base64') }), 'SYNC_PAYLOAD_INVALID');
    expectAppError(() => decryptSyncPayload(syncKey, { ...envelope, authTag: Buffer.alloc(16).toString('base64') }), 'SYNC_PAYLOAD_INVALID');
    expectAppError(() => decryptSyncPayload(syncKey, { ...envelope, payloadHash: '0'.repeat(64) }), 'SYNC_PAYLOAD_INVALID');
  });

  it('binds authentication to vault, revision, parent, device and key version metadata', () => {
    const syncKey = createSyncKey();
    const envelope = encryptSyncPayload({
      syncKey,
      vaultId: 'vault-1',
      revision: 1,
      parentRevision: null,
      deviceId: 'device-1',
      keyVersion: SYNC_KEY_VERSION,
      plaintext: Buffer.from('snapshot', 'utf8')
    });

    expect(encryptSyncPayload({
      syncKey,
      vaultId: 'vault-1',
      revision: 2,
      parentRevision: 1,
      deviceId: 'device-1',
      keyVersion: SYNC_KEY_VERSION,
      plaintext: Buffer.from('snapshot', 'utf8')
    }).aad).not.toBe(envelope.aad);

    for (const metadata of [
      { vaultId: 'vault-2' },
      { revision: 2 },
      { parentRevision: 0 },
      { deviceId: 'device-2' },
      { keyVersion: 2 }
    ]) {
      expectAppError(
        () => decryptSyncPayload(syncKey, { ...envelope, ...metadata }),
        'SYNC_PAYLOAD_INVALID'
      );
    }
  });

  it('rejects unsupported versions, malformed metadata and oversized payloads', () => {
    const syncKey = createSyncKey();
    const envelope = encryptSyncPayload({
      syncKey,
      vaultId: 'vault-1',
      revision: 1,
      parentRevision: null,
      deviceId: 'device-1',
      keyVersion: SYNC_KEY_VERSION,
      plaintext: Buffer.from('snapshot', 'utf8')
    });

    expectAppError(() => validateSyncEnvelope({ ...envelope, schemaVersion: 99 }), 'SYNC_PAYLOAD_INVALID');
    expectAppError(() => validateSyncEnvelope({ ...envelope, keyVersion: 99 }), 'SYNC_KEY_VERSION_UNSUPPORTED');
    expectAppError(() => validateSyncEnvelope({ ...envelope, byteLength: -1 }), 'SYNC_PAYLOAD_INVALID');
    expectAppError(() => validateSyncEnvelope({ ...envelope, nonce: 'not-base64' }), 'SYNC_PAYLOAD_INVALID');
    expectAppError(() => decryptSyncPayload(syncKey, { ...envelope, byteLength: SYNC_MAX_PAYLOAD_BYTES + 1 }), 'SYNC_PAYLOAD_INVALID');
  });

  it('keeps key version in the wrapping and payload AAD', () => {
    const currentVaultKey = vaultKey();
    const syncKey = createSyncKey();
    const wrapped = wrapSyncKey(currentVaultKey, 'vault-1', 2, syncKey);
    const envelope = encryptSyncPayload({
      syncKey,
      vaultId: 'vault-1',
      revision: 2,
      parentRevision: 1,
      deviceId: 'device-1',
      keyVersion: 2,
      plaintext: Buffer.from('rotated', 'utf8')
    });

    expect(unwrapSyncKey(currentVaultKey, 'vault-1', 2, wrapped)).toEqual(syncKey);
    expect(decryptSyncPayload(syncKey, envelope)).toEqual(Buffer.from('rotated', 'utf8'));
  });
});
