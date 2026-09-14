import { randomBytes } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import {
  ARGON2ID_PARAMS,
  VAULT_KEY_LENGTH,
  VAULT_SALT_LENGTH,
  VAULT_VERSION,
  type EncryptedJson,
  type VaultConfig,
  type VaultCreation
} from './types.js';
import {
  decodeSalt,
  decryptBytes,
  deriveVaultKeyEncryptionKey,
  encryptBytes
} from './crypto.js';

export type { EncryptedJson, VaultConfig, VaultCreation } from './types.js';

const MASTER_PASSWORD_MIN_LENGTH = 8;
const MASTER_PASSWORD_MAX_LENGTH = 4096;

const assertMasterPassword = (masterPassword: string): void => {
  if (
    typeof masterPassword !== 'string' ||
    masterPassword.length < MASTER_PASSWORD_MIN_LENGTH ||
    masterPassword.length > MASTER_PASSWORD_MAX_LENGTH
  ) {
    throw new AppError('MASTER_PASSWORD_INVALID');
  }
};

const assertVaultConfig = (config: VaultConfig): void => {
  if (
    typeof config !== 'object' ||
    config === null ||
    config.version !== VAULT_VERSION ||
    typeof config.kdf !== 'object' ||
    config.kdf === null ||
    config.kdf.algorithm !== ARGON2ID_PARAMS.algorithm ||
    config.kdf.memoryCost !== ARGON2ID_PARAMS.memoryCost ||
    config.kdf.timeCost !== ARGON2ID_PARAMS.timeCost ||
    config.kdf.parallelism !== ARGON2ID_PARAMS.parallelism ||
    config.kdf.hashLength !== ARGON2ID_PARAMS.hashLength
  ) {
    throw new AppError('VAULT_CONFIG_INVALID');
  }

  decodeSalt(config.kdf.salt);
}

const createVault = async (masterPassword: string): Promise<VaultCreation> => {
  assertMasterPassword(masterPassword);
  const salt = randomBytes(VAULT_SALT_LENGTH);
  const vaultKey = randomBytes(VAULT_KEY_LENGTH);
  let keyEncryptionKey: Buffer | undefined;

  try {
    keyEncryptionKey = await deriveVaultKeyEncryptionKey(masterPassword, salt, ARGON2ID_PARAMS);
    const wrappedVaultKey = encryptBytes(keyEncryptionKey, 'vault-key:v1', vaultKey);

    return {
      config: {
        version: VAULT_VERSION,
        kdf: {
          ...ARGON2ID_PARAMS,
          salt: salt.toString('base64')
        },
        wrappedVaultKey
      },
      vaultKey
    };
  } finally {
    keyEncryptionKey?.fill(0);
  }
};

const unlockVault = async (masterPassword: string, config: VaultConfig): Promise<Buffer> => {
  assertMasterPassword(masterPassword);
  let keyEncryptionKey: Buffer | undefined;

  try {
    assertVaultConfig(config);
    keyEncryptionKey = await deriveVaultKeyEncryptionKey(
      masterPassword,
      decodeSalt(config.kdf.salt),
      config.kdf
    );
    const vaultKey = decryptBytes(keyEncryptionKey, 'vault-key:v1', config.wrappedVaultKey);

    if (vaultKey.length !== VAULT_KEY_LENGTH) {
      throw new AppError('VAULT_UNLOCK_FAILED');
    }

    return vaultKey;
  } catch (error) {
    if (error instanceof AppError && error.code === 'MASTER_PASSWORD_INVALID') {
      throw error;
    }

    throw new AppError('VAULT_UNLOCK_FAILED');
  } finally {
    keyEncryptionKey?.fill(0);
  }
};

const encryptJson = <T>(key: Buffer, aad: string, value: T): EncryptedJson => {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error('value is not JSON serializable');
    }

    return encryptBytes(key, aad, Buffer.from(serialized, 'utf8'));
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    throw new AppError('VAULT_CRYPTO_FAILED');
  }
};

const decryptJson = async <T>(key: Buffer, aad: string, blob: EncryptedJson): Promise<T> => {
  const plaintext = decryptBytes(key, aad, blob);

  try {
    return JSON.parse(plaintext.toString('utf8')) as T;
  } catch {
    throw new AppError('VAULT_CRYPTO_FAILED');
  } finally {
    plaintext.fill(0);
  }
};

export class VaultService {
  static create = createVault;
  static unlock = unlockVault;
  static encryptJson = encryptJson;
  static decryptJson = decryptJson;

  create = createVault;
  unlock = unlockVault;
  encryptJson = encryptJson;
  decryptJson = decryptJson;
}
