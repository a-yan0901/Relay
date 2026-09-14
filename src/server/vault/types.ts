export const VAULT_VERSION = 1 as const;
export const VAULT_KEY_LENGTH = 32;
export const VAULT_SALT_LENGTH = 16;
export const VAULT_NONCE_LENGTH = 12;
export const VAULT_AUTH_TAG_LENGTH = 16;

export const ARGON2ID_PARAMS = {
  algorithm: 'argon2id',
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
  hashLength: VAULT_KEY_LENGTH
} as const;

export type Argon2idParams = typeof ARGON2ID_PARAMS;

export interface VaultKdfConfig extends Argon2idParams {
  salt: string;
}

export interface EncryptedJson {
  version: typeof VAULT_VERSION;
  nonce: string;
  ciphertext: string;
  authTag: string;
  aad: string;
}

export interface VaultConfig {
  version: typeof VAULT_VERSION;
  kdf: VaultKdfConfig;
  wrappedVaultKey: EncryptedJson;
}

export interface VaultCreation {
  config: VaultConfig;
  vaultKey: Buffer;
}
