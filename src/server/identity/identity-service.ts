import { randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import type { IdentityMetadata } from '../../shared/core/models.js';
import {
  identityCreateSchema,
  identityUpdateSchema,
  storedHostCredentialSchema,
  type IdentityCreateInput,
  type IdentityUpdateInput,
  type StoredHostCredential
} from '../../shared/validation.js';
import { IdentityRepository } from '../db/repositories.js';
import type { SqliteDatabase } from '../db/database.js';
import { VaultService, type EncryptedJson } from '../vault/vault-service.js';
import { VAULT_KEY_LENGTH } from '../vault/types.js';

const identityAad = (id: string): string => `identity:${id}:credentials:v1`;

const serializeEncrypted = (value: EncryptedJson): string => JSON.stringify(value);

const parseEncrypted = (value: string): EncryptedJson => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== 'object' || parsed === null ||
      !('version' in parsed) || !('nonce' in parsed) || !('ciphertext' in parsed) ||
      !('authTag' in parsed) || !('aad' in parsed)
    ) throw new Error('invalid encrypted identity');
    return parsed as EncryptedJson;
  } catch {
    throw new AppError('VAULT_CRYPTO_FAILED');
  }
};

const assertVaultKey = (vaultKey: Buffer): void => {
  if (!Buffer.isBuffer(vaultKey) || vaultKey.length !== VAULT_KEY_LENGTH) throw new AppError('VAULT_LOCKED');
};

export interface IdentityServiceOptions {
  database?: SqliteDatabase;
  repository?: IdentityRepository;
  vaultService: VaultService;
}

export class IdentityService {
  constructor(private readonly options: IdentityServiceOptions) {}

  private repository(ownerId: string): IdentityRepository {
    if (this.options.repository) return this.options.repository;
    if (this.options.database) return new IdentityRepository(this.options.database, ownerId);
    throw new AppError('INTERNAL_ERROR');
  }

  private metadata(ownerId: string, id: string): IdentityMetadata {
    const repository = this.repository(ownerId);
    const row = repository.get(id);
    if (!row) throw new AppError('IDENTITY_NOT_FOUND');
    return {
      id: row.id,
      name: row.name,
      type: row.type,
      username: row.username,
      keyFingerprint: row.keyFingerprint,
      usageCount: repository.countHostReferences(id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    };
  }

  async list(ownerId: string): Promise<IdentityMetadata[]> {
    const repository = this.repository(ownerId);
    return repository.list().map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      username: row.username,
      keyFingerprint: row.keyFingerprint,
      usageCount: repository.countHostReferences(row.id),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }));
  }

  async get(ownerId: string, id: string): Promise<IdentityMetadata | null> {
    const repository = this.repository(ownerId);
    if (!repository.get(id)) return null;
    return this.metadata(ownerId, id);
  }

  async create(ownerId: string, input: IdentityCreateInput, vaultKey: Buffer): Promise<IdentityMetadata> {
    assertVaultKey(vaultKey);
    const parsed = identityCreateSchema.safeParse(input);
    if (!parsed.success || parsed.data.type !== parsed.data.auth.type) throw new AppError('HOST_VALIDATION_FAILED');
    const id = randomUUID();
    const encrypted = await this.options.vaultService.encryptJson(vaultKey, identityAad(id), parsed.data.auth);
    this.repository(ownerId).create({
      ownerId,
      id,
      name: parsed.data.name,
      type: parsed.data.type,
      username: parsed.data.username,
      keyFingerprint: null,
      credentialCiphertext: serializeEncrypted(encrypted),
      credentialVersion: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    return this.metadata(ownerId, id);
  }

  async getCredential(ownerId: string, id: string, vaultKey: Buffer): Promise<StoredHostCredential> {
    assertVaultKey(vaultKey);
    const row = this.repository(ownerId).get(id);
    if (!row) throw new AppError('IDENTITY_NOT_FOUND');
    const credential = await this.options.vaultService.decryptJson<unknown>(vaultKey, identityAad(id), parseEncrypted(row.credentialCiphertext));
    const parsed = storedHostCredentialSchema.safeParse(credential);
    if (!parsed.success || parsed.data.type === 'pending') throw new AppError('VAULT_CRYPTO_FAILED');
    return parsed.data;
  }

  async update(ownerId: string, id: string, input: IdentityUpdateInput, vaultKey: Buffer): Promise<IdentityMetadata> {
    assertVaultKey(vaultKey);
    const parsed = identityUpdateSchema.safeParse(input);
    if (!parsed.success) throw new AppError('HOST_VALIDATION_FAILED');
    const repository = this.repository(ownerId);
    const current = repository.get(id);
    if (!current) throw new AppError('IDENTITY_NOT_FOUND');
    const nextType = parsed.data.type ?? parsed.data.auth?.type ?? current.type;
    if (parsed.data.type !== undefined && parsed.data.type !== current.type && !parsed.data.auth) {
      throw new AppError('HOST_VALIDATION_FAILED');
    }
    if (parsed.data.auth && parsed.data.auth.type !== nextType) throw new AppError('HOST_VALIDATION_FAILED');
    const patch = {
      name: parsed.data.name,
      username: parsed.data.username,
      type: nextType,
      ...(parsed.data.auth ? {
        credentialCiphertext: serializeEncrypted(await this.options.vaultService.encryptJson(vaultKey, identityAad(id), parsed.data.auth)),
        credentialVersion: 1
      } : {})
    };
    repository.update(id, patch);
    return this.metadata(ownerId, id);
  }

  async delete(ownerId: string, id: string): Promise<void> {
    this.repository(ownerId).delete(id);
  }
}
