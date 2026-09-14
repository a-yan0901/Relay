import { describe, expect, it } from 'vitest';

import { VaultService, type EncryptedJson } from '../../../src/server/vault/vault-service.js';

const masterPassword = 'correct horse battery staple';

describe('VaultService', () => {
  it('creates a vault that can be unlocked with the same master password', async () => {
    const created = await VaultService.create(masterPassword);
    const unlocked = await VaultService.unlock(masterPassword, created.config);

    expect(unlocked.equals(created.vaultKey)).toBe(true);
  });

  it('rejects a wrong master password without exposing crypto details', async () => {
    const created = await VaultService.create(masterPassword);

    await expect(VaultService.unlock('wrong horse battery staple', created.config))
      .rejects.toMatchObject({ code: 'VAULT_UNLOCK_FAILED' });
  });

  it('round-trips encrypted host credentials with authenticated AAD', async () => {
    const created = await VaultService.create(masterPassword);
    const credentials = {
      type: 'password',
      password: 'fixture-only-password'
    } as const;
    const aad = 'host:host-1:credentials:v1';

    const encrypted = await VaultService.encryptJson(created.vaultKey, aad, credentials);
    const decrypted = await VaultService.decryptJson<typeof credentials>(created.vaultKey, aad, encrypted);

    expect(decrypted).toEqual(credentials);
  });

  it('rejects ciphertext and AAD tampering', async () => {
    const created = await VaultService.create(masterPassword);
    const encrypted = await VaultService.encryptJson(created.vaultKey, 'host:host-1:credentials:v1', {
      type: 'private_key',
      privateKey: 'private-key-fixture',
      passphrase: 'key-passphrase-fixture'
    });

    const ciphertext = Buffer.from(encrypted.ciphertext, 'base64');
    ciphertext[0] ^= 1;
    const tamperedCiphertext: EncryptedJson = {
      ...encrypted,
      ciphertext: ciphertext.toString('base64')
    };

    await expect(VaultService.decryptJson(created.vaultKey, 'host:host-1:credentials:v1', tamperedCiphertext))
      .rejects.toMatchObject({ code: 'VAULT_CRYPTO_FAILED' });
    await expect(VaultService.decryptJson(created.vaultKey, 'host:host-2:credentials:v1', encrypted))
      .rejects.toMatchObject({ code: 'VAULT_CRYPTO_FAILED' });
  });

  it('uses a fresh nonce for every encryption', async () => {
    const created = await VaultService.create(masterPassword);
    const value = { type: 'password', password: 'same-value' } as const;

    const first = await VaultService.encryptJson(created.vaultKey, 'host:host-1:credentials:v1', value);
    const second = await VaultService.encryptJson(created.vaultKey, 'host:host-1:credentials:v1', value);

    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });

  it('serializes only KDF and wrapped-key material', async () => {
    const created = await VaultService.create(masterPassword);
    const serialized = JSON.stringify(created.config);

    expect(created.config.kdf).toMatchObject({
      algorithm: 'argon2id',
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32
    });
    expect(serialized).not.toContain(masterPassword);
    expect(serialized).not.toContain('fixture-only-password');
    expect(serialized).not.toContain('private-key-fixture');
  });
});
