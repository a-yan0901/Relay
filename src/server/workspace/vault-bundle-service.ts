import { randomBytes, randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import { validateJumpChain, type ConnectionProfileOverrides } from '../../shared/core/models.js';
import { resolveConnectionConfiguration } from '../../shared/core/connection-resolution.js';
import {
  connectionProfileSettingsPatchSchema,
  groupMutationSchema,
  hostMetadataInputSchema,
  identityCreateSchema,
  mergeConnectionProfileSettings,
  type ConnectionProfileSettings,
  storedHostCredentialSchema,
  type StoredHostCredential
} from '../../shared/validation.js';
import { GroupRepository, HostRepository, IdentityRepository, TerminalPreferenceRepository, TerminalProfileRepository } from '../db/repositories.js';
import { BUILTIN_TERMINAL_PROFILES, terminalAppearanceSchema, type TerminalProfile } from '../../shared/terminal-appearance.js';
import type { SqliteDatabase } from '../db/database.js';
import {
  ARGON2ID_PARAMS,
  VAULT_KEY_LENGTH,
  VAULT_SALT_LENGTH,
  type EncryptedJson
} from '../vault/types.js';
import { decodeSalt, decryptBytes, deriveVaultKeyEncryptionKey, encryptBytes } from '../vault/crypto.js';
import { VaultService } from '../vault/vault-service.js';
import type { IdentityService } from '../identity/identity-service.js';

const BUNDLE_FORMAT = 'webssh-vault';
const BUNDLE_VERSION = 1 as const;
const BUNDLE_WRAP_AAD = 'webssh-vault:bundle-key:v1';
const BUNDLE_PAYLOAD_AAD = 'webssh-vault:payload:v1';
const PREVIEW_TTL_MS = 10 * 60 * 1000;
const PASSWORD_MIN_LENGTH = 8;
const PASSWORD_MAX_LENGTH = 4096;

export interface BundleGroup {
  id: string;
  name: string;
  sortOrder: number;
  parentId?: string | null;
  defaultIdentityId?: string | null;
  connectionProfile?: ConnectionProfileOverrides | null;
}

export interface BundleIdentity {
  id: string;
  name: string;
  type: 'password' | 'private_key';
  username: string;
  keyFingerprint: string | null;
  auth: StoredHostCredential;
}

export interface BundleHost {
  id: string;
  name: string;
  address: string;
  port: number;
  username: string;
  auth: StoredHostCredential;
  groupId: string | null;
  jumpHostIds: string[];
  connectionProfile: ConnectionProfileSettings;
  tags: string[];
  isFavorite: boolean;
  hostKeyAlgorithm: string | null;
  hostKeyFingerprint: string | null;
  credentialSource?: 'inline' | 'identity' | 'group';
  identityId?: string | null;
  connectionProfileOverrides?: ConnectionProfileOverrides | null;
  terminalProfileId?: string | null;
}

export interface BundlePayload {
  groups: BundleGroup[];
  hosts: BundleHost[];
  identities?: BundleIdentity[];
  terminalProfiles?: TerminalProfile[];
  terminalDefaultProfileId?: string;
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
  type: 'host' | 'group' | 'identity';
  id: string;
  name: string;
}

export interface ImportPreview {
  previewId: string;
  hostCount: number;
  groupCount: number;
  identityCount: number;
  conflicts: ImportConflict[];
  expiresAt: string;
}

export interface ImportResolution {
  hostConflicts: 'skip' | 'replace';
  groupConflicts: 'reuse' | 'replace';
  identityConflicts?: 'reuse' | 'replace';
}

export interface ImportResult {
  importedHosts: number;
  importedGroups: number;
  skippedHosts: number;
  skippedGroups: number;
  importedIdentities: number;
  skippedIdentities: number;
}

interface PendingPreview {
  expiresAt: number;
  payload: BundlePayload;
  afterApply?: () => void;
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

const bundleIdentifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export const parsePayload = (value: unknown): BundlePayload => {
  if (typeof value !== 'object' || value === null) throw new AppError('VAULT_BUNDLE_INVALID');
  const candidate = value as Record<string, unknown>;
  if (!Array.isArray(candidate.groups) || !Array.isArray(candidate.hosts)) throw new AppError('VAULT_BUNDLE_INVALID');
  if (candidate.groups.length > 10_000 || candidate.hosts.length > 10_000 || (candidate.identities !== undefined && (!Array.isArray(candidate.identities) || candidate.identities.length > 10_000))) throw new AppError('VAULT_BUNDLE_INVALID');
  const identities: BundleIdentity[] = [];
  for (const value of candidate.identities ?? []) {
    if (typeof value !== 'object' || value === null) throw new AppError('VAULT_BUNDLE_INVALID');
    const identity = value as Record<string, unknown>;
    const parsed = identityCreateSchema.safeParse({ name: identity.name, type: identity.type, username: identity.username, auth: identity.auth });
    if (!parsed.success || typeof identity.id !== 'string' || !bundleIdentifier.test(identity.id) || (identity.keyFingerprint !== null && typeof identity.keyFingerprint !== 'string')) {
      throw new AppError('VAULT_BUNDLE_INVALID');
    }
    identities.push({
      id: identity.id,
      name: parsed.data.name,
      type: parsed.data.type,
      username: parsed.data.username,
      keyFingerprint: typeof identity.keyFingerprint === 'string' ? identity.keyFingerprint : null,
      auth: parsed.data.auth
    });
  }
  if (new Set(identities.map((identity) => identity.id)).size !== identities.length) throw new AppError('VAULT_BUNDLE_INVALID');

  const groups: BundleGroup[] = [];
  for (const value of candidate.groups) {
    if (typeof value !== 'object' || value === null) throw new AppError('VAULT_BUNDLE_INVALID');
    const group = value as Record<string, unknown>;
    const parsed = groupMutationSchema.safeParse({
      name: group.name,
      parentId: group.parentId,
      sortOrder: group.sortOrder,
      defaultIdentityId: group.defaultIdentityId,
      connectionProfile: group.connectionProfile
    });
    if (!parsed.success || typeof group.id !== 'string' || !bundleIdentifier.test(group.id)) throw new AppError('VAULT_BUNDLE_INVALID');
    groups.push({
      id: group.id,
      name: parsed.data.name,
      sortOrder: parsed.data.sortOrder,
      parentId: parsed.data.parentId ?? null,
      defaultIdentityId: parsed.data.defaultIdentityId ?? null,
      connectionProfile: parsed.data.connectionProfile ?? null
    });
  }
  if (new Set(groups.map((group) => group.id)).size !== groups.length) throw new AppError('VAULT_BUNDLE_INVALID');

  const terminalProfiles: TerminalProfile[] = [];
  if (candidate.terminalProfiles !== undefined) {
    if (!Array.isArray(candidate.terminalProfiles) || candidate.terminalProfiles.length > 100) throw new AppError('VAULT_BUNDLE_INVALID');
    for (const value of candidate.terminalProfiles) {
      if (typeof value !== 'object' || value === null) throw new AppError('VAULT_BUNDLE_INVALID');
      const profile = value as Record<string, unknown>;
      const appearance = terminalAppearanceSchema.safeParse(profile.appearance);
      if (!appearance.success || typeof profile.id !== 'string' || !bundleIdentifier.test(profile.id) || typeof profile.name !== 'string' || !profile.name || typeof profile.createdAt !== 'string' || typeof profile.updatedAt !== 'string') throw new AppError('VAULT_BUNDLE_INVALID');
      terminalProfiles.push({ id: profile.id, name: profile.name, appearance: appearance.data, createdAt: profile.createdAt, updatedAt: profile.updatedAt });
    }
    if (new Set(terminalProfiles.map((profile) => profile.id)).size !== terminalProfiles.length) throw new AppError('VAULT_BUNDLE_INVALID');
  }
  const terminalDefaultProfileId = candidate.terminalDefaultProfileId === undefined ? undefined : typeof candidate.terminalDefaultProfileId === 'string' && bundleIdentifier.test(candidate.terminalDefaultProfileId) ? candidate.terminalDefaultProfileId : (() => { throw new AppError('VAULT_BUNDLE_INVALID'); })();

  const hosts: BundleHost[] = [];
  for (const value of candidate.hosts) {
    if (typeof value !== 'object' || value === null) throw new AppError('VAULT_BUNDLE_INVALID');
    const host = value as Record<string, unknown>;
    const parsed = hostMetadataInputSchema.safeParse({
      name: host.name, address: host.address, port: host.port, username: host.username,
      groupId: host.groupId, terminalProfileId: host.terminalProfileId, jumpHostIds: host.jumpHostIds, connectionProfile: host.connectionProfile,
      tags: host.tags, isFavorite: host.isFavorite
    });
    const parsedAuth = storedHostCredentialSchema.safeParse(host.auth);
    let connectionProfileOverrides: ConnectionProfileOverrides | null | undefined;
    if (host.connectionProfileOverrides !== undefined) {
      const parsedOverrides = connectionProfileSettingsPatchSchema.nullable().safeParse(host.connectionProfileOverrides);
      if (!parsedOverrides.success) throw new AppError('VAULT_BUNDLE_INVALID');
      connectionProfileOverrides = parsedOverrides.data;
    }
    const credentialSource = host.credentialSource;
    const identityId = host.identityId === undefined || host.identityId === null
      ? host.identityId as null | undefined
      : typeof host.identityId === 'string' && bundleIdentifier.test(host.identityId) ? host.identityId : '__invalid__';
    if (
      !parsed.success || !parsedAuth.success || typeof host.id !== 'string' || !bundleIdentifier.test(host.id) ||
      (credentialSource !== undefined && credentialSource !== 'inline' && credentialSource !== 'identity' && credentialSource !== 'group') ||
      (credentialSource === 'identity' && typeof identityId !== 'string') ||
      (credentialSource !== 'identity' && identityId !== undefined && identityId !== null) ||
      identityId === '__invalid__'
    ) {
      throw new AppError('VAULT_BUNDLE_INVALID');
    }
    const parsedHost: BundleHost = {
      id: host.id, name: parsed.data.name, address: parsed.data.address, port: parsed.data.port, username: parsed.data.username,
      auth: parsedAuth.data, groupId: parsed.data.groupId ?? null, jumpHostIds: parsed.data.jumpHostIds ?? [],
      connectionProfile: mergeConnectionProfileSettings(parsed.data.connectionProfile), tags: parsed.data.tags, isFavorite: parsed.data.isFavorite,
      hostKeyAlgorithm: typeof host.hostKeyAlgorithm === 'string' ? host.hostKeyAlgorithm : null,
      hostKeyFingerprint: typeof host.hostKeyFingerprint === 'string' ? host.hostKeyFingerprint : null,
      ...(credentialSource === undefined ? {} : { credentialSource }),
      ...(identityId === undefined ? {} : { identityId }),
      ...(connectionProfileOverrides === undefined ? {} : { connectionProfileOverrides }),
      terminalProfileId: parsed.data.terminalProfileId ?? null
    };
    hosts.push(parsedHost);
  }
  if (new Set(hosts.map((host) => host.id)).size !== hosts.length) throw new AppError('VAULT_BUNDLE_INVALID');
  const identityIds = new Set(identities.map((identity) => identity.id));
  for (const group of groups) if (group.defaultIdentityId && !identityIds.has(group.defaultIdentityId)) throw new AppError('VAULT_BUNDLE_INVALID');
  for (const host of hosts) if (host.credentialSource === 'identity' && (!host.identityId || !identityIds.has(host.identityId))) throw new AppError('VAULT_BUNDLE_INVALID');
  return { groups, hosts, identities, terminalProfiles, ...(terminalDefaultProfileId === undefined ? {} : { terminalDefaultProfileId }) };
};

const orderBundleGroups = (groups: readonly BundleGroup[]): BundleGroup[] => {
  const byId = new Map(groups.map((group) => [group.id, group]));
  const depths = new Map<string, number>();
  const depthOf = (id: string, active: Set<string>): number => {
    const cached = depths.get(id);
    if (cached !== undefined) return cached;
    if (active.has(id)) throw new AppError('VAULT_BUNDLE_INVALID');
    const group = byId.get(id);
    if (!group) throw new AppError('VAULT_BUNDLE_INVALID');
    if (group.parentId === null || group.parentId === undefined) {
      depths.set(id, 1);
      return 1;
    }
    const next = depthOf(group.parentId, new Set([...active, id])) + 1;
    if (next > 8) throw new AppError('VAULT_BUNDLE_INVALID');
    depths.set(id, next);
    return next;
  };
  for (const group of groups) depthOf(group.id, new Set());
  return [...groups].sort((left, right) => (depths.get(left.id) ?? 0) - (depths.get(right.id) ?? 0));
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
  identityService?: IdentityService;
  terminalProfileRepository?: TerminalProfileRepository;
  terminalPreferenceRepository?: TerminalPreferenceRepository;
}

export class VaultBundleService {
  private readonly previews = new Map<string, PendingPreview>();

  constructor(private readonly options: VaultBundleServiceOptions) {}

  /** Build the canonical plaintext payload shared by export and encrypted sync. */
  async createPayload(sessionKey: Buffer): Promise<BundlePayload> {
    assertSessionKey(sessionKey);
    const groupNodes = this.options.groupRepository.list();
    const groups: BundleGroup[] = groupNodes.map((group) => ({
      id: group.id,
      name: group.name,
      sortOrder: group.sortOrder,
      parentId: group.parentId,
      defaultIdentityId: group.defaultIdentityId,
      connectionProfile: group.connectionProfile
    }));
    const identityMetadata = this.options.identityService ? await this.options.identityService.list(this.options.ownerId) : [];
    if (!this.options.identityService && groupNodes.some((group) => group.defaultIdentityId !== null)) throw new AppError('IDENTITY_NOT_FOUND');
    const identityCredentials = new Map<string, StoredHostCredential>();
    const identities: BundleIdentity[] = [];
    for (const identity of identityMetadata) {
      const auth = await this.options.identityService!.getCredential(this.options.ownerId, identity.id, sessionKey);
      identityCredentials.set(identity.id, auth);
      identities.push({ id: identity.id, name: identity.name, type: identity.type, username: identity.username, keyFingerprint: identity.keyFingerprint, auth });
    }
    const terminalProfileRepository = this.options.terminalProfileRepository ?? new TerminalProfileRepository(this.options.database, this.options.ownerId);
    const terminalPreferenceRepository = this.options.terminalPreferenceRepository ?? new TerminalPreferenceRepository(this.options.database, this.options.ownerId);
    const terminalProfiles = terminalProfileRepository.list();
    const terminalDefaultProfileId = terminalPreferenceRepository.getDefaultProfileId() ?? 'builtin:midnight';
    const hostRows = this.options.hostRepository.listForBundle();
    if (!this.options.identityService && hostRows.some((row) => row.credentialSource?.type !== 'inline')) throw new AppError('IDENTITY_NOT_FOUND');
    const hosts: BundleHost[] = [];
    for (const row of hostRows) {
      let auth: StoredHostCredential;
      const resolved = resolveConnectionConfiguration(row, groupNodes);
      const identityId = row.credentialSource?.type === 'identity'
        ? row.identityId
        : row.credentialSource?.type === 'group' ? resolved.identityId : null;
      if (identityId) {
        if (!this.options.identityService) throw new AppError('IDENTITY_NOT_FOUND');
        auth = identityCredentials.get(identityId) ?? await this.options.identityService.getCredential(this.options.ownerId, identityId, sessionKey);
      } else {
        if (row.credentialSource?.type === 'group') throw new AppError('IDENTITY_NOT_FOUND');
        if (row.credentialCiphertext === null) throw new AppError('VAULT_BUNDLE_INVALID');
        auth = await this.options.vaultService.decryptJson<StoredHostCredential>(sessionKey, hostCredentialAad(row.id), parseStoredCredential(row.credentialCiphertext));
      }
      if (!storedHostCredentialSchema.safeParse(auth).success) throw new AppError('VAULT_BUNDLE_INVALID');
      const credentialSource = row.credentialSource?.type ?? 'inline';
      hosts.push({
        id: row.id,
        name: row.name,
        address: row.address,
        port: row.port,
        username: row.username,
        auth,
        groupId: row.groupId,
        jumpHostIds: [...(row.jumpHostIds ?? [])],
        connectionProfile: row.connectionProfile ?? mergeConnectionProfileSettings(undefined),
        connectionProfileOverrides: row.connectionProfileOverrides ?? null,
        terminalProfileId: row.terminalProfileId ?? null,
        tags: [...row.tags],
        isFavorite: row.isFavorite,
        hostKeyAlgorithm: row.hostKeyAlgorithm,
        hostKeyFingerprint: row.hostKeyFingerprint,
        credentialSource,
        ...(credentialSource === 'identity' ? { identityId: row.identityId } : {})
      });
    }
    return { groups, hosts, identities, terminalProfiles, terminalDefaultProfileId };
  }

  async export(sessionKey: Buffer, exportPassword: string): Promise<string> {
    assertSessionKey(sessionKey);
    assertPassword(exportPassword);
    const payloadValue = await this.createPayload(sessionKey);
    const payload = Buffer.from(JSON.stringify(payloadValue satisfies BundlePayload), 'utf8');
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

  /** Apply an already validated plaintext payload through the same transactional import path. */
  async applyPayload(
    sessionKey: Buffer,
    payload: BundlePayload,
    resolution: ImportResolution,
    afterApply?: () => void
  ): Promise<ImportResult> {
    assertSessionKey(sessionKey);
    const previewId = randomUUID();
    this.previews.set(previewId, { expiresAt: Date.now() + PREVIEW_TTL_MS, payload, afterApply });
    try {
      return await this.applyImport(sessionKey, previewId, resolution);
    } finally {
      this.previews.delete(previewId);
    }
  }

  async previewImport(sessionKey: Buffer, exportPassword: string, bundle: string): Promise<ImportPreview> {
    assertSessionKey(sessionKey);
    assertPassword(exportPassword);
    this.prunePreviews();
    const payload = await this.decryptBundle(exportPassword, bundle);
    const conflicts: ImportConflict[] = [];
    const identityRepository = new IdentityRepository(this.options.database, this.options.ownerId);
    for (const identity of payload.identities ?? []) {
      if (identityRepository.get(identity.id)) conflicts.push({ type: 'identity', id: identity.id, name: identity.name });
    }
    for (const group of payload.groups) {
      if (this.options.groupRepository.get(group.id)) conflicts.push({ type: 'group', id: group.id, name: group.name });
    }
    for (const host of payload.hosts) {
      if (this.options.hostRepository.getForConnection(host.id)) conflicts.push({ type: 'host', id: host.id, name: host.name });
    }
    const previewId = randomUUID();
    const expiresAt = Date.now() + PREVIEW_TTL_MS;
    this.previews.set(previewId, { expiresAt, payload });
    return { previewId, hostCount: payload.hosts.length, groupCount: payload.groups.length, identityCount: payload.identities?.length ?? 0, conflicts, expiresAt: new Date(expiresAt).toISOString() };
  }

  async applyImport(sessionKey: Buffer, previewId: string, resolution: ImportResolution): Promise<ImportResult> {
    assertSessionKey(sessionKey);
    this.prunePreviews();
    const pending = this.previews.get(previewId);
    if (!pending) throw new AppError('VAULT_BUNDLE_PREVIEW_EXPIRED');
    if (!['skip', 'replace'].includes(resolution.hostConflicts) || !['reuse', 'replace'].includes(resolution.groupConflicts) || (resolution.identityConflicts !== undefined && !['reuse', 'replace'].includes(resolution.identityConflicts))) throw new AppError('VAULT_BUNDLE_INVALID');
    validateImportedJumpGraph(pending.payload.hosts, this.options.hostRepository.listMetadata(), resolution.hostConflicts);
    const identityConflicts = resolution.identityConflicts ?? 'reuse';
    const identityRepository = new IdentityRepository(this.options.database, this.options.ownerId);
    const identities: Array<BundleIdentity & { existing: ReturnType<IdentityRepository['get']>; credentialCiphertext: string }> = [];
    for (const identity of pending.payload.identities ?? []) {
      const encrypted = await this.options.vaultService.encryptJson(sessionKey, `identity:${identity.id}:credentials:v1`, identity.auth);
      identities.push({ ...identity, existing: identityRepository.get(identity.id), credentialCiphertext: JSON.stringify(encrypted) });
    }
    const groups: Array<BundleGroup & { existing: ReturnType<GroupRepository['get']> }> = [];
    for (const group of orderBundleGroups(pending.payload.groups)) {
      groups.push({ ...group, existing: this.options.groupRepository.get(group.id) });
    }
    const hosts: Array<BundleHost & { existing: ReturnType<HostRepository['getForConnection']>; credentialCiphertext: string | null }> = [];
    for (const host of pending.payload.hosts) {
      const source = host.credentialSource ?? 'inline';
      const encrypted = source === 'inline'
        ? await this.options.vaultService.encryptJson(sessionKey, hostCredentialAad(host.id), host.auth)
        : null;
      hosts.push({
        ...host,
        existing: this.options.hostRepository.getForConnection(host.id),
        credentialCiphertext: encrypted ? JSON.stringify(encrypted) : null
      });
    }
    const operation = this.options.database.transaction((): ImportResult => {
      let importedIdentities = 0;
      let skippedIdentities = 0;
      let importedGroups = 0;
      let skippedGroups = 0;
      let importedHosts = 0;
      let skippedHosts = 0;
      for (const identity of identities) {
        if (identity.existing) {
          if (identityConflicts === 'reuse') { skippedIdentities += 1; continue; }
          identityRepository.update(identity.id, {
            name: identity.name,
            type: identity.type,
            username: identity.username,
            keyFingerprint: identity.keyFingerprint,
            credentialCiphertext: identity.credentialCiphertext,
            credentialVersion: 1
          });
          importedIdentities += 1;
        } else {
          identityRepository.create({
            id: identity.id,
            ownerId: this.options.ownerId,
            name: identity.name,
            type: identity.type,
            username: identity.username,
            keyFingerprint: identity.keyFingerprint,
            credentialCiphertext: identity.credentialCiphertext,
            credentialVersion: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          importedIdentities += 1;
        }
      }
      const terminalProfileRepository = this.options.terminalProfileRepository ?? new TerminalProfileRepository(this.options.database, this.options.ownerId);
      const terminalPreferenceRepository = this.options.terminalPreferenceRepository ?? new TerminalPreferenceRepository(this.options.database, this.options.ownerId);
      for (const profile of pending.payload.terminalProfiles ?? []) {
        if (!terminalProfileRepository.get(profile.id)) terminalProfileRepository.create(profile);
      }
      const importedDefault = pending.payload.terminalDefaultProfileId;
      if (importedDefault && (BUILTIN_TERMINAL_PROFILES.some((profile) => profile.id === importedDefault) || terminalProfileRepository.get(importedDefault))) terminalPreferenceRepository.setDefaultProfileId(importedDefault);
      for (const group of groups) {
        if (group.existing) {
          if (resolution.groupConflicts === 'reuse') { skippedGroups += 1; continue; }
          this.options.groupRepository.update(group.id, {
            name: group.name,
            parentId: group.parentId ?? null,
            sortOrder: group.sortOrder,
            defaultIdentityId: group.defaultIdentityId ?? null,
            connectionProfile: group.connectionProfile ?? null
          });
          importedGroups += 1;
        } else {
          this.options.groupRepository.create({
            id: group.id,
            name: group.name,
            parentId: group.parentId ?? null,
            sortOrder: group.sortOrder,
            defaultIdentityId: group.defaultIdentityId ?? null,
            connectionProfile: group.connectionProfile ?? null
          });
          importedGroups += 1;
        }
      }
      for (const host of hosts) {
        if (host.existing) {
          if (resolution.hostConflicts === 'skip') { skippedHosts += 1; continue; }
          this.options.hostRepository.deleteHost(host.id);
        }
        const source = host.credentialSource ?? 'inline';
        const identityId = source === 'identity' ? host.identityId ?? null : null;
        if (source === 'identity') {
          if (!identityId || !identityRepository.get(identityId)) throw new AppError('IDENTITY_NOT_FOUND');
        }
        if (source === 'group') {
          const resolved = resolveConnectionConfiguration({ groupId: host.groupId, credentialSource: { type: 'group' } }, this.options.groupRepository.list());
          if (!resolved.identityId) throw new AppError('IDENTITY_NOT_FOUND');
        }
        const connectionProfileOverrides = host.connectionProfileOverrides === undefined ? host.connectionProfile : host.connectionProfileOverrides;
        this.options.hostRepository.createHost({
          id: host.id, ownerId: this.options.ownerId, name: host.name, address: host.address, port: host.port, username: host.username,
          authType: host.auth.type === 'pending' ? host.auth.authType : host.auth.type, credentialCiphertext: host.credentialCiphertext, credentialVersion: 1,
          credentialSource: source, identityId,
          hostKeyAlgorithm: host.hostKeyAlgorithm, hostKeyFingerprint: host.hostKeyFingerprint, groupId: host.groupId, terminalProfileId: host.terminalProfileId ?? null, jumpHostIds: host.jumpHostIds, tags: host.tags,
          connectionProfile: mergeConnectionProfileSettings(connectionProfileOverrides ?? undefined),
          connectionProfileOverrides: connectionProfileOverrides ?? null,
          isFavorite: host.isFavorite, lastConnectedAt: null
        });
        importedHosts += 1;
      }
      pending.afterApply?.();
      return { importedHosts, importedGroups, skippedHosts, skippedGroups, importedIdentities, skippedIdentities };
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
