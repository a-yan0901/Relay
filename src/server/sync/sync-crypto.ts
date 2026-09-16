import { createHash, randomBytes } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import type { SyncEnvelope, WrappedKeyEnvelope } from '../../shared/core/models.js';
import {
  decryptBytes,
  encryptBytes
} from '../vault/crypto.js';
import {
  VAULT_AUTH_TAG_LENGTH,
  VAULT_KEY_LENGTH,
  VAULT_NONCE_LENGTH
} from '../vault/types.js';

export const SYNC_SCHEMA_VERSION = 1 as const;
export const SYNC_KEY_VERSION = 1 as const;
export const RECOVERY_KEY_VERSION = 1 as const;
export const SYNC_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
const MAX_SYNC_KEY_VERSION = 32;
const MAX_IDENTIFIER_LENGTH = 128;
const HEX_HASH_PATTERN = /^[a-f0-9]{64}$/u;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const RECOVERY_KEY_PREFIX = 'RLYRK1';
const RECOVERY_KEY_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const RECOVERY_KEY_BODY_LENGTH = 52;
const RECOVERY_KEY_CHECKSUM_LENGTH = 4;

const failPayload = (): never => {
  throw new AppError('SYNC_PAYLOAD_INVALID');
};

const asString = (value: unknown): string => typeof value === 'string' ? value : failPayload();

const assertKey = (key: Buffer): void => {
  if (!Buffer.isBuffer(key) || key.length !== VAULT_KEY_LENGTH) {
    throw new AppError('VAULT_CRYPTO_FAILED');
  }
};

const assertIdentifier = (value: string): void => {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    [...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f || character === '\u007f')
  ) {
    failPayload();
  }
};

const assertKeyVersion = (value: number): void => {
  if (!Number.isInteger(value) || value < 1 || value > MAX_SYNC_KEY_VERSION) {
    throw new AppError('SYNC_KEY_VERSION_UNSUPPORTED');
  }
};

const decodeBase64 = (value: unknown, expectedLength?: number): Buffer => {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) failPayload();
  const decoded = Buffer.from(value as string, 'base64');
  if (expectedLength !== undefined && decoded.length !== expectedLength) failPayload();
  return decoded;
};

const syncKeyAad = (vaultId: string, keyVersion: number): string => (
  `relay-sync:key:v1:${vaultId}:${keyVersion}`
);

const recoveryKeyAad = (vaultId: string, keyVersion: number): string => (
  `relay-sync:recovery:v1:${vaultId}:${keyVersion}`
);

const payloadAad = (envelope: Pick<SyncEnvelope, 'vaultId' | 'revision' | 'parentRevision' | 'deviceId' | 'keyVersion'>): string => (
  `relay-sync:payload:v1:${envelope.vaultId}:${envelope.revision}:${envelope.parentRevision ?? 'root'}:${envelope.keyVersion}:${envelope.deviceId}`
);

const toWrappedKeyEnvelope = (value: ReturnType<typeof encryptBytes>): WrappedKeyEnvelope => ({
  version: value.version,
  nonce: value.nonce,
  ciphertext: value.ciphertext,
  authTag: value.authTag,
  aad: value.aad
});

const assertWrappedKeyEnvelope = (value: WrappedKeyEnvelope): void => {
  if (typeof value !== 'object' || value === null || value.version !== 1) {
    throw new AppError('VAULT_CRYPTO_FAILED');
  }
  decodeBase64(value.nonce, VAULT_NONCE_LENGTH);
  decodeBase64(value.authTag, VAULT_AUTH_TAG_LENGTH);
  decodeBase64(value.ciphertext);
  decodeBase64(value.aad);
};

const failRecoveryKey = (): never => {
  throw new AppError('VAULT_UNLOCK_FAILED');
};

const encodeRecoveryBase32 = (value: Buffer): string => {
  let buffer = 0;
  let bits = 0;
  let encoded = '';
  for (const byte of value) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += RECOVERY_KEY_ALPHABET[(buffer >> bits) & 0x1f];
    }
    if (bits > 0) buffer &= (1 << bits) - 1;
    else buffer = 0;
  }
  if (bits > 0) encoded += RECOVERY_KEY_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return encoded;
};

const decodeRecoveryBase32 = (value: string): Buffer => {
  if (!/^[A-Z2-7]+$/u.test(value)) return failRecoveryKey();
  let buffer = 0;
  let bits = 0;
  const decoded: number[] = [];
  for (const character of value) {
    const digit = RECOVERY_KEY_ALPHABET.indexOf(character);
    if (digit < 0) return failRecoveryKey();
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      decoded.push((buffer >> bits) & 0xff);
      if (bits > 0) buffer &= (1 << bits) - 1;
      else buffer = 0;
    }
  }
  if (bits > 0 && buffer !== 0) return failRecoveryKey();
  const result = Buffer.from(decoded);
  if (result.length !== VAULT_KEY_LENGTH) return failRecoveryKey();
  return result;
};

const recoveryKeyChecksum = (key: Buffer): string => (
  encodeRecoveryBase32(createHash('sha256').update(key).digest()).slice(0, RECOVERY_KEY_CHECKSUM_LENGTH)
);

export const createRecoveryKey = (): Buffer => randomBytes(VAULT_KEY_LENGTH);

export const formatRecoveryKey = (key: Buffer): string => {
  assertKey(key);
  const content = `${encodeRecoveryBase32(key)}${recoveryKeyChecksum(key)}`;
  const groups = content.match(/.{1,4}/gu) ?? [];
  return `${RECOVERY_KEY_PREFIX.slice(0, 3)}-${RECOVERY_KEY_PREFIX.slice(3)}-${groups.join('-')}`;
};

export const parseRecoveryKey = (value: string): Buffer => {
  if (typeof value !== 'string' || value.length > 128) return failRecoveryKey();
  const normalized = value.replace(/[\s-]/gu, '').toUpperCase();
  const content = normalized.startsWith(RECOVERY_KEY_PREFIX) ? normalized.slice(RECOVERY_KEY_PREFIX.length) : '';
  if (content.length !== RECOVERY_KEY_BODY_LENGTH + RECOVERY_KEY_CHECKSUM_LENGTH) return failRecoveryKey();
  const key = decodeRecoveryBase32(content.slice(0, RECOVERY_KEY_BODY_LENGTH));
  if (content.slice(RECOVERY_KEY_BODY_LENGTH) !== recoveryKeyChecksum(key)) {
    key.fill(0);
    return failRecoveryKey();
  }
  return key;
};

export const createSyncKey = (): Buffer => randomBytes(VAULT_KEY_LENGTH);

export const wrapVaultKeyWithRecoveryKey = (
  vaultKey: Buffer,
  vaultId: string,
  keyVersion: number,
  recoveryKey: Buffer
): WrappedKeyEnvelope => {
  assertKey(vaultKey);
  assertIdentifier(vaultId);
  assertKeyVersion(keyVersion);
  assertKey(recoveryKey);
  return toWrappedKeyEnvelope(encryptBytes(recoveryKey, recoveryKeyAad(vaultId, keyVersion), vaultKey));
};

export const unwrapVaultKeyWithRecoveryKey = (
  recoveryKey: Buffer,
  vaultId: string,
  keyVersion: number,
  wrapped: WrappedKeyEnvelope
): Buffer => {
  assertKey(recoveryKey);
  assertIdentifier(vaultId);
  assertKeyVersion(keyVersion);
  assertWrappedKeyEnvelope(wrapped);
  try {
    const vaultKey = decryptBytes(recoveryKey, recoveryKeyAad(vaultId, keyVersion), {
      version: 1,
      nonce: wrapped.nonce,
      ciphertext: wrapped.ciphertext,
      authTag: wrapped.authTag,
      aad: wrapped.aad
    });
    assertKey(vaultKey);
    return vaultKey;
  } catch (error) {
    if (error instanceof AppError && error.code === 'SYNC_KEY_VERSION_UNSUPPORTED') throw error;
    throw new AppError('VAULT_UNLOCK_FAILED');
  }
};

export const wrapSyncKey = (
  vaultKey: Buffer,
  vaultId: string,
  keyVersion: number,
  syncKey: Buffer
): WrappedKeyEnvelope => {
  assertKey(vaultKey);
  assertIdentifier(vaultId);
  assertKeyVersion(keyVersion);
  assertKey(syncKey);
  return toWrappedKeyEnvelope(encryptBytes(vaultKey, syncKeyAad(vaultId, keyVersion), syncKey));
};

export const unwrapSyncKey = (
  vaultKey: Buffer,
  vaultId: string,
  keyVersion: number,
  wrapped: WrappedKeyEnvelope
): Buffer => {
  assertKey(vaultKey);
  assertIdentifier(vaultId);
  assertKeyVersion(keyVersion);
  assertWrappedKeyEnvelope(wrapped);
  try {
    const syncKey = decryptBytes(vaultKey, syncKeyAad(vaultId, keyVersion), {
      version: 1,
      nonce: wrapped.nonce,
      ciphertext: wrapped.ciphertext,
      authTag: wrapped.authTag,
      aad: wrapped.aad
    });
    assertKey(syncKey);
    return syncKey;
  } catch (error) {
    if (error instanceof AppError && error.code === 'SYNC_KEY_VERSION_UNSUPPORTED') throw error;
    throw new AppError('VAULT_CRYPTO_FAILED');
  }
};

export const encryptSyncPayload = (input: {
  syncKey: Buffer;
  vaultId: string;
  revision: number;
  parentRevision: number | null;
  deviceId: string;
  keyVersion: number;
  plaintext: Buffer;
}): SyncEnvelope => {
  assertKey(input.syncKey);
  assertIdentifier(input.vaultId);
  assertIdentifier(input.deviceId);
  assertKeyVersion(input.keyVersion);
  if (
    !Number.isSafeInteger(input.revision) || input.revision < 1 ||
    (input.parentRevision !== null && (!Number.isSafeInteger(input.parentRevision) || input.parentRevision < 0))
  ) {
    failPayload();
  }
  if (!Buffer.isBuffer(input.plaintext) || input.plaintext.length > SYNC_MAX_PAYLOAD_BYTES) {
    failPayload();
  }

  const metadata = {
    vaultId: input.vaultId,
    revision: input.revision,
    parentRevision: input.parentRevision,
    deviceId: input.deviceId,
    keyVersion: input.keyVersion
  } satisfies Pick<SyncEnvelope, 'vaultId' | 'revision' | 'parentRevision' | 'deviceId' | 'keyVersion'>;
  const encrypted = encryptBytes(input.syncKey, payloadAad(metadata), input.plaintext);
  const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    vaultId: input.vaultId,
    revision: input.revision,
    parentRevision: input.parentRevision,
    deviceId: input.deviceId,
    keyVersion: input.keyVersion,
    nonce: encrypted.nonce,
    ciphertext: encrypted.ciphertext,
    authTag: encrypted.authTag,
    aad: encrypted.aad,
    payloadHash: createHash('sha256').update(ciphertext).digest('hex'),
    byteLength: input.plaintext.length
  };
};

export const validateSyncEnvelope = (value: unknown): SyncEnvelope => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) failPayload();
  const candidate = value as Record<string, unknown>;
  const expectedKeys = new Set([
    'schemaVersion',
    'vaultId',
    'revision',
    'parentRevision',
    'deviceId',
    'keyVersion',
    'nonce',
    'ciphertext',
    'authTag',
    'aad',
    'payloadHash',
    'byteLength'
  ]);
  if (Object.keys(candidate).some((key) => !expectedKeys.has(key)) || Object.keys(candidate).length !== expectedKeys.size) failPayload();
  if (candidate.schemaVersion !== SYNC_SCHEMA_VERSION) failPayload();
  if (!Number.isSafeInteger(candidate.revision) || (candidate.revision as number) < 1) failPayload();
  if (candidate.parentRevision !== null && (!Number.isSafeInteger(candidate.parentRevision) || (candidate.parentRevision as number) < 0)) failPayload();
  const vaultId = asString(candidate.vaultId);
  const deviceId = asString(candidate.deviceId);
  assertIdentifier(vaultId);
  assertIdentifier(deviceId);
  if (!Number.isSafeInteger(candidate.keyVersion)) throw new AppError('SYNC_KEY_VERSION_UNSUPPORTED');
  assertKeyVersion(candidate.keyVersion as number);
  const byteLength = candidate.byteLength;
  if (!Number.isSafeInteger(byteLength) || (byteLength as number) < 0 || (byteLength as number) > SYNC_MAX_PAYLOAD_BYTES) failPayload();
  const nonceValue = asString(candidate.nonce);
  const authTagValue = asString(candidate.authTag);
  const ciphertextValue = asString(candidate.ciphertext);
  const aadValue = asString(candidate.aad);
  const payloadHash = asString(candidate.payloadHash);
  const nonce = decodeBase64(nonceValue, VAULT_NONCE_LENGTH);
  const authTag = decodeBase64(authTagValue, VAULT_AUTH_TAG_LENGTH);
  const ciphertext = decodeBase64(ciphertextValue);
  decodeBase64(aadValue);
  if (!HEX_HASH_PATTERN.test(payloadHash)) failPayload();
  if (ciphertext.length !== byteLength) failPayload();
  if (nonce.length !== VAULT_NONCE_LENGTH || authTag.length !== VAULT_AUTH_TAG_LENGTH) failPayload();
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    vaultId,
    revision: candidate.revision as number,
    parentRevision: candidate.parentRevision as number | null,
    deviceId,
    keyVersion: candidate.keyVersion as number,
    nonce: nonceValue,
    ciphertext: ciphertextValue,
    authTag: authTagValue,
    aad: aadValue,
    payloadHash,
    byteLength: byteLength as number
  };
};

export const decryptSyncPayload = (syncKey: Buffer, value: SyncEnvelope): Buffer => {
  assertKey(syncKey);
  const envelope = validateSyncEnvelope(value);
  const actualHash = createHash('sha256').update(Buffer.from(envelope.ciphertext, 'base64')).digest('hex');
  if (actualHash !== envelope.payloadHash) failPayload();
  let plaintext: Buffer | undefined;
  try {
    plaintext = decryptBytes(syncKey, payloadAad(envelope), {
      version: 1,
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
      authTag: envelope.authTag,
      aad: envelope.aad
    });
    if (plaintext.length !== envelope.byteLength) {
      plaintext.fill(0);
      failPayload();
    }
    return plaintext;
  } catch {
    plaintext?.fill(0);
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
};
