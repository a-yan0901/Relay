import { randomBytes, randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import { validateJumpChain } from '../../shared/core/models.js';
import {
  hostCreateSchema,
  mergeConnectionProfileSettings,
  type ConnectionProfileSettings,
  type HostCredentialInput
} from '../../shared/validation.js';
import { GroupRepository, HostRepository } from '../db/repositories.js';
import type { SqliteDatabase } from '../db/database.js';
import {
  ARGON2ID_PARAMS,
  VAULT_KEY_LENGTH,
  VAULT_SALT_LENGTH,
  type EncryptedJson
} from '../vault/types.js';
import { decodeSalt, decryptBytes, deriveVaultKeyEncryptionKey, encryptBytes } from '../vault/crypto.js';
import { VaultService } from '../vault/vault-service.js';

const BUNDLE_FORMAT = 'webssh-vault';
const BUNDLE_VERSION = 1 as const;
const BUNDLE_WRAP_AAD = 'webssh-vault:bundle-key:v1';
const BUNDLE_PAYLOAD_AAD = 'webssh-vault:payload:v1';
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 4096;

interface BundleGroup {
  id: string;
  name: string;
  sortOrder: number;
}

interface BundleHost {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  auth: HostCredentialInput;
  groupId: string | null;
  jumpHostIds: string[];
  connectionProfile: ConnectionProfileSettings;
  tags: string[];
  isFavorite: boolean;
  hostKeyAlgorithm: string | null;
  hostKeyFingerprint: string | null;
}

interface BundlePayload {
  groups: BundleGroup[];
  hosts: BundleHost[];
}

interface VaultBundleEnvelope {
  format: typeof BUNDLE_FORMAT;
  version: typeof BUNDLE_VERSION;
  kdf: {
    algorithm: typeof ARGON2ID_PARAMS.algorithm;
    memoryCost: number;
    timeCost: number;
    parallelism: number;
    hashLength: number;
    salt: string;
  };
  wrappedBundleKey: EncryptedJson;
  payload: EncryptedJson;
}

export interface ImportConflict {
  type: 'host' | 'group';
  id: string;
  name: string;
}

export interface ImportPreview {
  previewId: string;
  hostCount: number;
  groupCount: number;
  conflicts: ImportConflict[];
  expiresAt: string;
}

export interface ImportResolution {
  hostConflicts: 'skip' | 'replace';
  groupConflicts: 'reuse' | 'replace';
}

export interface ImportResult {
  importedHosts: number;
  importedGroups: number;
  skippedHosts: number;
  skippedGroups: number;
}

interface PendingPreview {
  expiresAt: number;
  payload: BundlePayload;
}

const validateImportedJumpGraph = (
  hosts: readonly BundleHost[],
  existingHosts: readonly { id: string; jumpHostIds?: readonly string[] }[],
  hostConflicts: ImportResolution['hostConflicts']
): void => {
  const existingIds = new Set(existingHosts.map((host) => host.id));
  const profiles = new Map(existingHosts.map((host) => [host.id, { jumpHostIds: [...(host.jumpHostIds ?? [])] }]));
  for (const host of hosts) {
    if (!existingIds.has(host.id) || hostConflicts === 'replace') profiles.set(host.id, { jumpHostIds: [...host.jumpHostIds] });
  }
  try {
    for (const host of hosts) {
      if (existingIds.has(host.id) && hostConflicts === 'skip') continue;
      validateJumpChain(host.id, profiles);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('not found')) throw new AppError('VAULT_BUNDLE_INVALID');
    throw new AppError('HOST_VALIDATION_FAILED');
  }
};

const assertPassword = (password: string): void => {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new AppError('VAULT_BUNDLE_INVALID');
  }
};

const assertSessionKey = (key: Buffer): void => {
  if (!Buffer.isBuffer(key) || key.length !== VAULT_KEY_LENGTH) throw new AppError('VAULT_BUNDLE_INVALID');
};

const parseEncryptedJson = (value: unknown): EncryptedJson => {
  if (typeof value !== 'object' || value === null) throw new AppError('VAULT_BUNDLE_INVALID');
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== BUNDLE_VERSION || typeof candidate.nonce !== 'string' || typeof candidate.ciphertext !== 'string' || typeof candidate.authTag !== 'string' || typeof candidate.aad !== 'string') {
    throw new AppError('VAULT_BUNDLE_INVALID');
  }
  return candidate as unknown as EncryptedJson;
};

const parseJson = (value: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new AppError('VAULT_BUNDLE_INVALID');
  }
};

const parsePayload = (value: unknown): BundlePayload => {
  if (typeof value !== 'object' || value === null) throw new AppError('VAULT_BUNDLE_INVALID');
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.groups) || !Array.isArray(candidate.hosts)) throw new AppError('VAULT_BUNDLE_INVALID');
  if (candidate.groups.length > 10_000 || candidate.hosts.length > 10_000) throw new AppError('VAULT_BUNDLE_INVALID');
  const groups: BundleGroup[] = [];
  for (const value of candidate.groups) {
    if (typeof value !== 'object' || value === null) throw new AppError('VAULT_BUNDLE_INVALID');
    const group = value as Record<string, unknown>;
    if (typeof group.id !== 'string' || typeof group.name !== 'string' || typeof group.sortOrder !== 'number') throw new AppError('VAULT_BUNDLE_INVALID');
    groups.push({ id: group.id, name: group.name, sortOrder: group.sortOrder });
  }
  const hosts: BundleHost[] = [];
  for (const value of candidate.hosts) {
    if (typeof value !== 'object' || value === null) throw new AppError('VAULT_BUNDLE_INVALID');
    const host = value as Record<string, unknown>;
    const parsed = hostCreateSchema.safeParse({
      name: host.name, address: host.address, port: host.port, username: host.username, auth: host.auth,
      groupId: host.groupId, jumpHostIds: host.jumpHostIds, connectionProfile: host.connectionProfile,
      tags: host.tags, isFavorite: host.isFavorite
    });
    if (!parsed.success || typeof host.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(host.id)) {
      throw new AppError('VAULT_BUNDLE_INVALID');
    }
    hosts.push({
      id: host.id, name: parsed.data.name, address: parsed.data.address, port: parsed.data.port, username: parsed.data.username,
      auth: parsed.data.auth, groupId: parsed.data.groupId ?? null, jumpHostIds: parsed.data.jumpHostIds ?? [],
      connectionProfile: mergeConnectionProfileSettings(parsed.data.connectionProfile), tags: parsed.data.tags, isFavorite: parsed.data.isFavorite,
      hostKeyAlgorithm: typeof host.hostKeyAlgorithm === 'string' ? host.hostKeyAlgorithm : null,
      hostKeyFingerprint: typeof host.hostKeyFingerprint === 'string' ? host.hostKeyFingerprint : null
    });
  }
  return { groups, hosts };
};

const parseEnvelope = (value: string): VaultBundleEnvelope => {
  const parsed = parseJson(value);
  if (typeof parsed !== 'object' || parsed === null) throw new AppError('VAULT_BUNDLE_INVALID');
  const candidate = parsed as Record<string, unknown>;
  if (candidate.format !== BUNDLE_FORMAT || candidate.version !== BUNDLE_VERSION || typeof candidate.kdf !== 'object' || candidate.kdf === null) {
    throw new AppError('VAULT_BUNDLE_INVALID');
  }
  const kdf = candidate.kdf as Record<string, unknown>;
  if (kdf.algorithm !== ARGON2ID_PARAMS.algorithm || kdf.memoryCost !== ARGON2ID_PARAMS.memoryCost || kdf.timeCost !== ARGON2ID_PARAMS.timeCost || kdf.parallelism !== ARGON2ID_PARAMS.parallelism || kdf.hashLength !== ARGON2ID_PARAMS.hashLength || typeof kdf.salt !== 'string') {
    throw new AppError('VAULT_BUNDLE_INVALID');
  }
  decodeSalt(kdf.salt);
  return {
    format: BUNDLE_FORMAT, version: BUNDLE_VERSION,
    kdf: { algorithm: ARGON2ID_PARAMS.algorithm, memoryCost: ARGON2ID_PARAMS.memoryCost, timeCost: ARGON2ID_PARAMS.timeCost, parallelism: ARGON2ID_PARAMS.parallelism, hashLength: ARGON2ID_PARAMS.hashLength, salt: kdf.salt },
    wrappedBundleKey: parseEncryptedJson(candidate.wrappedBundleKey),
    payload: parseEncryptedJson(candidate.payload)
  };
};

const hostCredentialAad = (id: string): string => `host:${id}:credentials:v1`;
const parseStoredCredential = (value: string): EncryptedJson => parseEncryptedJson(parseJson(value));

export interface VaultBundleServiceOptions {
  ownerId: string;
  database: SqliteDatabase;
  hostRepository: HostRepository;
  groupRepository: GroupRepository;
  vaultService: VaultService;
}

export class VaultBundleService {
  private readonly previews = new Map<string, PendingPreview>();

  constructor(private readonly options: VaultBundleServiceOptions) {}

  async export(sessionKey: Buffer, exportPassword: string): Promise<string> {
    assertSessionKey(sessionKey);
    assertPassword(exportPassword);
    const groups = this.options.groupRepository.list().map((group) => ({ id: group.id, name: group.name, sortOrder: group.sortOrder }));
    const hosts: BundleHost[] = [];
    for (const row of this.options.hostRepository.listForBundle()) {
      const auth = await this.options.vaultService.decryptJson<HostCredentialInput>(sessionKey, hostCredentialAad(row.id), parseStoredCredential(row.credentialCiphertext));
      hosts.push({ id: row.id, name: row.name, address: row.address, port: row.port, username: row.username, auth, groupId: row.groupId, jumpHostIds: [...(row.jumpHostIds ?? [])], connectionProfile: row.connectionProfile ?? mergeConnectionProfileSettings(undefined), tags: [...row.tags], isFavorite: row.isFavorite, hostKeyAlgorithm: row.hostKeyAlgorithm, hostKeyFingerprint: row.hostKeyFingerprint });
    }
    const payload = Buffer.from(JSON.stringify({ groups, hosts } satisfies BundlePayload), 'utf8');
    const bundleKey = randomBytes(VAULT_KEY_LENGTH);
    const salt = randomBytes(VAULT_SALT_LENGTH);
    let exportKey: Buffer | undefined;
    try {
      exportKey = await deriveVaultKeyEncryptionKey(exportPassword, salt, ARGON2ID_PARAMS);
      const envelope: VaultBundleEnvelope = {
        format: BUNDLE_FORMAT, version: BUNDLE_VERSION,
        kdf: { ...ARGON2ID_PARAMS, salt: salt.toString('base64') },
        wrappedBundleKey: encryptBytes(exportKey, BUNDLE_WRAP_AAD, bundleKey),
        payload: encryptBytes(bundleKey, BUNDLE_PAYLOAD_AAD, payload)
      };
      return JSON.stringify(envelope);
    } catch (error) {
      if (error instanceof AppError && error.code === 'VAULT_BUNDLE_INVALID') throw error;
      throw error;
    } finally {
      payload.fill(0);
      bundleKey.fill(0);
      exportKey?.fill(0);
      salt.fill(0);
    }
  }

  async previewImport(sessionKey: Buffer, exportPassword: string, bundle: string): Promise<ImportPreview> {
    assertSessionKey(sessionKey);
    assertPassword(exportPassword);
    this.prunePreviews();
    const payload = await this.decryptBundle(exportPassword, bundle);
    const conflicts: ImportConflict[] = [];
    for (const group of payload.groups) {
      if (this.options.groupRepository.get(group.id)) conflicts.push({ type: 'group', id: group.id, name: group.name });
    }
    for (const host of payload.hosts) {
      if (this.options.hostRepository.getForConnection(host.id)) conflicts.push({ type: 'host', id: host.id, name: host.name });
    }
    const previewId = randomUUID();
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    this.previews.set(previewId, { expiresAt, payload });
    return { previewId, hostCount: payload.hosts.length, groupCount: payload.groups.length, conflicts, expiresAt: new Date(expiresAt).toISOString() };
  }

  async applyImport(sessionKey: Buffer, previewId: string, resolution: ImportResolution): Promise<ImportResult> {
    assertSessionKey(sessionKey);
    this.prunePreviews();
    const pending = this.previews.get(previewId);
    if (!pending) throw new AppError('VAULT_BUNDLE_PREVIEW_EXPIRED');
    if (!['skip', 'replace'].includes(resolution.hostConflicts) || !['reuse', 'replace'].includes(resolution.groupConflicts)) throw new AppError('VAULT_BUNDLE_INVALID');
    validateImportedJumpGraph(pending.payload.hosts, this.options.hostRepository.listMetadata(), resolution.hostConflicts);
    const groups: Array<BundleGroup & { existing: ReturnType<GroupRepository['get']> }> = [];
    for (const group of pending.payload.groups) {
      groups.push({ ...group, existing: this.options.groupRepository.get(group.id) });
    }
    const hosts: Array<BundleHost & { existing: ReturnType<HostRepository['getForConnection']>; credentialCiphertext: string }> = [];
    for (const host of pending.payload.hosts) {
      const encrypted = await this.options.vaultService.encryptJson(sessionKey, hostCredentialAad(host.id), host.auth);
      hosts.push({
        ...host,
        existing: this.options.hostRepository.getForConnection(host.id),
        credentialCiphertext: JSON.stringify(encrypted)
      });
    }
    const operation = this.options.database.transaction((): ImportResult => {
      let importedGroups = 0;
      let skippedGroups = 0;
      let importedHosts = 0;
      let skippedHosts = 0;
      for (const group of groups) {
        if (group.existing) {
          if (resolution.groupConflicts === 'reuse') { skippedGroups += 1; continue; }
          this.options.groupRepository.update(group.id, { name: group.name, sortOrder: group.sortOrder });
          importedGroups += 1;
        } else {
          this.options.groupRepository.create({ id: group.id, name: group.name, sortOrder: group.sortOrder });
          importedGroups += 1;
        }
      }
      for (const host of hosts) {
        if (host.existing) {
          if (resolution.hostConflicts === 'skip') { skippedHosts += 1; continue; }
          this.options.hostRepository.deleteHost(host.id);
        }
        this.options.hostRepository.createHost({
          id: host.id, ownerId: this.options.ownerId, name: host.name, address: host.address, port: host.port, username: host.username,
          authType: host.auth.type, credentialCiphertext: host.credentialCiphertext, credentialVersion: 1,
          hostKeyAlgorithm: host.hostKeyAlgorithm, hostKeyFingerprint: host.hostKeyFingerprint, groupId: host.groupId, jumpHostIds: host.jumpHostIds, tags: host.tags,
          connectionProfile: host.connectionProfile, isFavorite: host.isFavorite, lastConnectedAt: null
        });
        importedHosts += 1;
      }
      return { importedHosts, importedGroups, skippedHosts, skippedGroups };
    });
    const result = operation();
    this.previews.delete(previewId);
    return result;
  }

  private async decryptBundle(exportPassword: string, serialized: string): Promise<BundlePayload> {
    let exportKey: Buffer | undefined;
    let bundleKey: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      const envelope = parseEnvelope(serialized);
      exportKey = await deriveVaultKeyEncryptionKey(exportPassword, decodeSalt(envelope.kdf.salt), ARGON2ID_PARAMS);
      bundleKey = decryptBytes(exportKey, BUNDLE_WRAP_AAD, envelope.wrappedBundleKey);
      if (bundleKey.length !== VAULT_KEY_LENGTH) throw new AppError('VAULT_BUNDLE_INVALID');
      plaintext = decryptBytes(bundleKey, BUNDLE_PAYLOAD_AAD, envelope.payload);
      return parsePayload(parseJson(plaintext.toString('utf8')));
    } catch (error) {
      if (error instanceof AppError && error.code === 'VAULT_BUNDLE_INVALID') throw error;
      throw new AppError('VAULT_BUNDLE_INVALID');
    } finally {
      plaintext?.fill(0);
      bundleKey?.fill(0);
      exportKey?.fill(0);
    }
  }

  private prunePreviews(): void {
    const now = Date.now();
    for (const [id, preview] of this.previews) if (preview.expiresAt <= now) this.previews.delete(id);
  }
}
