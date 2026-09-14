import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import {
  ARGON2ID_PARAMS,
  VAULT_AUTH_TAG_LENGTH,
  VAULT_KEY_LENGTH,
  VAULT_NONCE_LENGTH,
  VAULT_SALT_LENGTH,
  VAULT_VERSION,
  type Argon2idParams,
  type EncryptedJson
} from './types.js';

const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const MAX_AAD_LENGTH = 1024;

const failCrypto = (): never => {
  throw new AppError('VAULT_CRYPTO_FAILED');
};

const decodeBase64 = (value: unknown, expectedLength?: number): Buffer => {
  if (typeof value !== 'string' || !BASE64_PATTERN.test(value)) {
    return failCrypto();
  }

  const decoded = Buffer.from(value, 'base64');
  if (expectedLength !== undefined && decoded.length !== expectedLength) {
    return failCrypto();
  }

  return decoded;
};

const assertKey = (key: Buffer): void => {
  if (!Buffer.isBuffer(key) || key.length !== VAULT_KEY_LENGTH) {
    failCrypto();
  }
};

const assertAad = (aad: string): Buffer => {
  if (typeof aad !== 'string' || aad.length === 0 || aad.length > MAX_AAD_LENGTH) {
    return failCrypto();
  }

  return Buffer.from(aad, 'utf8');
};

const assertKdfParams = (params: Argon2idParams): void => {
  if (
    params.algorithm !== ARGON2ID_PARAMS.algorithm ||
    params.memoryCost !== ARGON2ID_PARAMS.memoryCost ||
    params.timeCost !== ARGON2ID_PARAMS.timeCost ||
    params.parallelism !== ARGON2ID_PARAMS.parallelism ||
    params.hashLength !== ARGON2ID_PARAMS.hashLength
  ) {
    throw new AppError('VAULT_CONFIG_INVALID');
  }
};

export const deriveVaultKeyEncryptionKey = async (
  masterPassword: string,
  salt: Buffer,
  params: Argon2idParams = ARGON2ID_PARAMS
): Promise<Buffer> => {
  assertKdfParams(params);
  if (typeof masterPassword !== 'string' || salt.length !== VAULT_SALT_LENGTH) {
    throw new AppError('VAULT_CONFIG_INVALID');
  }

  const argon2 = await import('argon2');
  return argon2.hash(masterPassword, {
    type: argon2.argon2id,
    raw: true,
    salt,
    memoryCost: params.memoryCost,
    timeCost: params.timeCost,
    parallelism: params.parallelism,
    hashLength: params.hashLength
  });
};

export const encryptBytes = (key: Buffer, aad: string, plaintext: Buffer): EncryptedJson => {
  assertKey(key);
  const aadBytes = assertAad(aad);
  if (!Buffer.isBuffer(plaintext)) {
    failCrypto();
  }

  try {
    const nonce = randomBytes(VAULT_NONCE_LENGTH);
    const cipher = createCipheriv('aes-256-gcm', key, nonce);
    cipher.setAAD(aadBytes);
    const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);

    return {
      version: VAULT_VERSION,
      nonce: nonce.toString('base64'),
      ciphertext: ciphertext.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
      aad: aadBytes.toString('base64')
    };
  } catch {
    return failCrypto();
  }
};

const assertEncryptedJson = (blob: EncryptedJson): void => {
  if (
    typeof blob !== 'object' ||
    blob === null ||
    blob.version !== VAULT_VERSION ||
    typeof blob.nonce !== 'string' ||
    typeof blob.ciphertext !== 'string' ||
    typeof blob.authTag !== 'string' ||
    typeof blob.aad !== 'string'
  ) {
    failCrypto();
  }

  decodeBase64(blob.nonce, VAULT_NONCE_LENGTH);
  decodeBase64(blob.authTag, VAULT_AUTH_TAG_LENGTH);
  decodeBase64(blob.ciphertext);
  decodeBase64(blob.aad);
};

export const decryptBytes = (key: Buffer, aad: string, blob: EncryptedJson): Buffer => {
  assertKey(key);
  const aadBytes = assertAad(aad);
  assertEncryptedJson(blob);

  if (blob.aad !== aadBytes.toString('base64')) {
    failCrypto();
  }

  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      key,
      decodeBase64(blob.nonce, VAULT_NONCE_LENGTH)
    );
    decipher.setAAD(aadBytes);
    decipher.setAuthTag(decodeBase64(blob.authTag, VAULT_AUTH_TAG_LENGTH));
    return Buffer.concat([
      decipher.update(decodeBase64(blob.ciphertext)),
      decipher.final()
    ]);
  } catch {
    return failCrypto();
  }
};

export const decodeSalt = (salt: string): Buffer => decodeBase64(salt, VAULT_SALT_LENGTH);
