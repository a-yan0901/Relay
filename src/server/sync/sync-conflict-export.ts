import { randomBytes } from 'node:crypto';

import type { SyncConflictExport, SyncConflictExportCopy } from '../../shared/core/models.js';
import {
  parseSyncConflictExport,
  serializeSyncConflictExport,
  SYNC_CONFLICT_EXPORT_FORMAT,
  SYNC_CONFLICT_EXPORT_KDF,
  SYNC_CONFLICT_EXPORT_MAX_PAYLOAD_BYTES,
  SYNC_CONFLICT_EXPORT_PASSWORD_MAX_LENGTH,
  SYNC_CONFLICT_EXPORT_PASSWORD_MIN_LENGTH,
  SYNC_CONFLICT_EXPORT_VERSION
} from '../../shared/core/sync-conflict-export.js';
import { AppError } from '../../shared/errors.js';
import { decodeSalt, decryptBytes, deriveVaultKeyEncryptionKey, encryptBytes } from '../vault/crypto.js';
import { VAULT_KEY_LENGTH, VAULT_SALT_LENGTH, type EncryptedJson } from '../vault/types.js';

export interface SyncConflictExportCopyInput {
  conflictId: string;
  copy: SyncConflictExportCopy['copy'];
  revision: number;
  payloadHash: string;
  plaintext: Buffer;
  exportPassword: string;
}

export interface AssembleSyncConflictExportInput {
  conflictId: string;
  createdAt: string;
  local: SyncConflictExportCopy;
  remote: SyncConflictExportCopy;
}

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const HASH = /^[a-f0-9]{64}$/u;

const invalid = (): never => {
  throw new AppError('SYNC_PAYLOAD_INVALID');
};

export const assertSyncConflictExportPassword = (password: string): void => {
  if (typeof password !== 'string'
    || password.length < SYNC_CONFLICT_EXPORT_PASSWORD_MIN_LENGTH
    || password.length > SYNC_CONFLICT_EXPORT_PASSWORD_MAX_LENGTH) invalid();
};

const assertCopyInput = (input: SyncConflictExportCopyInput): void => {
  if (!SAFE_ID.test(input.conflictId)
    || (input.copy !== 'local' && input.copy !== 'remote')
    || !Number.isSafeInteger(input.revision)
    || input.revision < 1
    || input.revision > 1_000_000_000
    || !HASH.test(input.payloadHash)
    || !Buffer.isBuffer(input.plaintext)
    || input.plaintext.length > SYNC_CONFLICT_EXPORT_MAX_PAYLOAD_BYTES) invalid();
  assertSyncConflictExportPassword(input.exportPassword);
};

const conflictAad = (conflictId: string, copy: SyncConflictExportCopy['copy']): string => (
  `relay-sync-conflict:v1:${conflictId}:${copy}`
);

const asEncryptedJson = (envelope: SyncConflictExportCopy['payload']): EncryptedJson => ({
  version: 1,
  nonce: envelope.nonce,
  ciphertext: envelope.ciphertext,
  authTag: envelope.authTag,
  aad: envelope.aad
});

const mapCryptoFailure = (error: unknown): never => {
  if (error instanceof AppError && error.code === 'SYNC_PAYLOAD_INVALID') throw error;
  throw new AppError('SYNC_PAYLOAD_INVALID');
};

export const createSyncConflictExportCopy = async (
  input: SyncConflictExportCopyInput
): Promise<SyncConflictExportCopy> => {
  assertCopyInput(input);
  const salt = randomBytes(VAULT_SALT_LENGTH);
  const bundleKey = randomBytes(VAULT_KEY_LENGTH);
  let exportKey: Buffer | undefined;
  try {
    exportKey = await deriveVaultKeyEncryptionKey(input.exportPassword, salt, SYNC_CONFLICT_EXPORT_KDF);
    const aad = conflictAad(input.conflictId, input.copy);
    return {
      copy: input.copy,
      revision: input.revision,
      payloadHash: input.payloadHash,
      kdf: { ...SYNC_CONFLICT_EXPORT_KDF, salt: salt.toString('base64') },
      wrappedBundleKey: encryptBytes(exportKey, aad, bundleKey),
      payload: encryptBytes(bundleKey, aad, input.plaintext)
    };
  } catch (error) {
    return mapCryptoFailure(error);
  } finally {
    salt.fill(0);
    bundleKey.fill(0);
    exportKey?.fill(0);
  }
};

export const assembleSyncConflictExport = (input: AssembleSyncConflictExportInput): SyncConflictExport => {
  const exported: SyncConflictExport = {
    format: SYNC_CONFLICT_EXPORT_FORMAT,
    version: SYNC_CONFLICT_EXPORT_VERSION,
    conflictId: input.conflictId,
    createdAt: input.createdAt,
    copies: [input.local, input.remote]
  };
  serializeSyncConflictExport(exported);
  return parseSyncConflictExport(exported);
};

export const decryptSyncConflictExportCopy = async (
  conflictId: string,
  copy: SyncConflictExportCopy,
  exportPassword: string
): Promise<Buffer> => {
  if (!SAFE_ID.test(conflictId)
    || (copy.copy !== 'local' && copy.copy !== 'remote')
    || typeof exportPassword !== 'string'
    || exportPassword.length < SYNC_CONFLICT_EXPORT_PASSWORD_MIN_LENGTH
    || exportPassword.length > SYNC_CONFLICT_EXPORT_PASSWORD_MAX_LENGTH
    || copy.kdf.algorithm !== SYNC_CONFLICT_EXPORT_KDF.algorithm
    || copy.kdf.memoryCost !== SYNC_CONFLICT_EXPORT_KDF.memoryCost
    || copy.kdf.timeCost !== SYNC_CONFLICT_EXPORT_KDF.timeCost
    || copy.kdf.parallelism !== SYNC_CONFLICT_EXPORT_KDF.parallelism
    || copy.kdf.hashLength !== SYNC_CONFLICT_EXPORT_KDF.hashLength) return invalid();

  let salt: Buffer | undefined;
  let exportKey: Buffer | undefined;
  let bundleKey: Buffer | undefined;
  try {
    salt = decodeSalt(copy.kdf.salt);
    if (salt.length !== VAULT_SALT_LENGTH) return invalid();
    exportKey = await deriveVaultKeyEncryptionKey(exportPassword, salt, SYNC_CONFLICT_EXPORT_KDF);
    const aad = conflictAad(conflictId, copy.copy);
    bundleKey = decryptBytes(exportKey, aad, asEncryptedJson(copy.wrappedBundleKey));
    if (bundleKey.length !== VAULT_KEY_LENGTH) return invalid();
    return decryptBytes(bundleKey, aad, asEncryptedJson(copy.payload));
  } catch (error) {
    return mapCryptoFailure(error);
  } finally {
    salt?.fill(0);
    exportKey?.fill(0);
    bundleKey?.fill(0);
  }
};
