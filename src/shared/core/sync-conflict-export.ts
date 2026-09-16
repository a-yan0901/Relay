import { AppError } from '../errors.js';
import type { SyncConflictExport, SyncConflictExportCopy, SyncConflictExportKdf, WrappedKeyEnvelope } from './models.js';

export const SYNC_CONFLICT_EXPORT_FORMAT = 'relay-sync-conflict' as const;
export const SYNC_CONFLICT_EXPORT_VERSION = 1 as const;
export const SYNC_CONFLICT_EXPORT_MAX_BYTES = 96 * 1024 * 1024;
export const SYNC_CONFLICT_EXPORT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;
export const SYNC_CONFLICT_EXPORT_PASSWORD_MIN_LENGTH = 8;
export const SYNC_CONFLICT_EXPORT_PASSWORD_MAX_LENGTH = 4_096;

export const SYNC_CONFLICT_EXPORT_KDF = {
  algorithm: 'argon2id',
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: 32
} as const;

const HASH_PATTERN = /^[a-f0-9]{64}$/u;
const SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const MAX_REVISION = 1_000_000_000;
const ENVELOPE_KEYS = ['version', 'nonce', 'ciphertext', 'authTag', 'aad'] as const;
const KDF_KEYS = ['algorithm', 'memoryCost', 'timeCost', 'parallelism', 'hashLength', 'salt'] as const;
const COPY_KEYS = ['copy', 'revision', 'payloadHash', 'kdf', 'wrappedBundleKey', 'payload'] as const;
const ROOT_KEYS = ['format', 'version', 'conflictId', 'createdAt', 'copies'] as const;
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const fail = (): never => {
  throw new AppError('SYNC_PAYLOAD_INVALID');
};

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
};

const isIntegerInRange = (value: unknown, min: number, max: number): value is number => (
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
);

const decodedBase64Length = (value: string): number => {
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  return (value.length / 4) * 3 - padding;
};

const isBase64 = (value: string): boolean => {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  let contentLength = value.length;
  if (value.endsWith('==')) contentLength -= 2;
  else if (value.endsWith('=')) contentLength -= 1;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const valid = (code >= 0x41 && code <= 0x5a)
      || (code >= 0x61 && code <= 0x7a)
      || (code >= 0x30 && code <= 0x39)
      || code === 0x2b
      || code === 0x2f;
    if (!valid) return false;
  }
  return value.slice(contentLength).replace(/=/gu, '').length === 0;
};

const assertBase64 = (value: unknown, minLength: number, maxLength: number): string => {
  if (value === '' && minLength === 0) return value;
  if (typeof value !== 'string' || !isBase64(value)) return fail();
  const decodedLength = decodedBase64Length(value);
  if (!Number.isSafeInteger(decodedLength) || decodedLength < minLength || decodedLength > maxLength) return fail();
  return value;
};

const base64EncodeAscii = (value: string): string => {
  let output = '';
  for (let index = 0; index < value.length; index += 3) {
    const first = value.charCodeAt(index);
    const hasSecond = index + 1 < value.length;
    const hasThird = index + 2 < value.length;
    const second = hasSecond ? value.charCodeAt(index + 1) : 0;
    const third = hasThird ? value.charCodeAt(index + 2) : 0;
    if (first > 0xff || second > 0xff || third > 0xff) return fail();
    const word = (first << 16) | (second << 8) | third;
    output += BASE64_ALPHABET[(word >>> 18) & 0x3f];
    output += BASE64_ALPHABET[(word >>> 12) & 0x3f];
    output += hasSecond ? BASE64_ALPHABET[(word >>> 6) & 0x3f] : '=';
    output += hasThird ? BASE64_ALPHABET[word & 0x3f] : '=';
  }
  return output;
};

const parseEnvelope = (value: unknown, ciphertextLength: { min: number; max: number }): WrappedKeyEnvelope => {
  if (!isRecord(value) || !hasExactKeys(value, ENVELOPE_KEYS) || value.version !== 1) return fail();
  const nonce = assertBase64(value.nonce, 12, 12);
  const ciphertext = assertBase64(value.ciphertext, ciphertextLength.min, ciphertextLength.max);
  const authTag = assertBase64(value.authTag, 16, 16);
  const aad = assertBase64(value.aad, 1, 1_024);
  return { version: 1, nonce, ciphertext, authTag, aad };
};

const parseKdf = (value: unknown): SyncConflictExportKdf => {
  if (!isRecord(value) || !hasExactKeys(value, KDF_KEYS)
    || value.algorithm !== SYNC_CONFLICT_EXPORT_KDF.algorithm
    || value.memoryCost !== SYNC_CONFLICT_EXPORT_KDF.memoryCost
    || value.timeCost !== SYNC_CONFLICT_EXPORT_KDF.timeCost
    || value.parallelism !== SYNC_CONFLICT_EXPORT_KDF.parallelism
    || value.hashLength !== SYNC_CONFLICT_EXPORT_KDF.hashLength) return fail();
  return {
    algorithm: 'argon2id',
    memoryCost: SYNC_CONFLICT_EXPORT_KDF.memoryCost,
    timeCost: SYNC_CONFLICT_EXPORT_KDF.timeCost,
    parallelism: SYNC_CONFLICT_EXPORT_KDF.parallelism,
    hashLength: SYNC_CONFLICT_EXPORT_KDF.hashLength,
    salt: assertBase64(value.salt, 16, 16)
  };
};

const parseCopy = (value: unknown, conflictId: string): SyncConflictExportCopy => {
  if (!isRecord(value) || !hasExactKeys(value, COPY_KEYS)
    || (value.copy !== 'local' && value.copy !== 'remote')
    || !isIntegerInRange(value.revision, 1, MAX_REVISION)
    || typeof value.payloadHash !== 'string'
    || !HASH_PATTERN.test(value.payloadHash)) return fail();
  const copy = value.copy as SyncConflictExportCopy['copy'];
  const expectedAad = base64EncodeAscii(`relay-sync-conflict:v1:${conflictId}:${copy}`);
  const wrappedBundleKey = parseEnvelope(value.wrappedBundleKey, { min: 32, max: 32 });
  const payload = parseEnvelope(value.payload, { min: 0, max: SYNC_CONFLICT_EXPORT_MAX_PAYLOAD_BYTES });
  if (wrappedBundleKey.aad !== expectedAad || payload.aad !== expectedAad) return fail();
  return {
    copy,
    revision: value.revision,
    payloadHash: value.payloadHash,
    kdf: parseKdf(value.kdf),
    wrappedBundleKey,
    payload
  };
};

export const parseSyncConflictExport = (value: unknown): SyncConflictExport => {
  if (!isRecord(value) || !hasExactKeys(value, ROOT_KEYS)
    || value.format !== SYNC_CONFLICT_EXPORT_FORMAT
    || value.version !== SYNC_CONFLICT_EXPORT_VERSION
    || typeof value.conflictId !== 'string'
    || !SAFE_ID_PATTERN.test(value.conflictId)
    || typeof value.createdAt !== 'string'
    || Number.isNaN(Date.parse(value.createdAt))
    || new Date(value.createdAt).toISOString() !== value.createdAt
    || !Array.isArray(value.copies)
    || value.copies.length !== 2) return fail();

  const conflictId = value.conflictId;
  const copies = value.copies.map((copy) => parseCopy(copy, conflictId));
  if (copies[0]?.copy !== 'local' || copies[1]?.copy !== 'remote') return fail();
  return {
    format: SYNC_CONFLICT_EXPORT_FORMAT,
    version: SYNC_CONFLICT_EXPORT_VERSION,
    conflictId,
    createdAt: value.createdAt,
    copies: [copies[0], copies[1]]
  };
};

export const serializeSyncConflictExport = (value: SyncConflictExport): string => {
  const parsed = parseSyncConflictExport(value);
  const serialized = JSON.stringify(parsed);
  if (serialized.length > SYNC_CONFLICT_EXPORT_MAX_BYTES) return fail();
  return serialized;
};
