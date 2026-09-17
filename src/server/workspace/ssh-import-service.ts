import { randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import { validateJumpChain } from '../../shared/core/models.js';
import { resolveConnectionConfiguration } from '../../shared/core/connection-resolution.js';
import { exportGenericCsv, exportOpenSshConfig } from '../../shared/import/export.js';
import { resolveImportConnections, stableImportKey, type ResolvedImportedConnection } from '../../shared/import/dedupe.js';
import { extractImportZip } from '../../shared/import/zip.js';
import { parseImportSource } from '../../shared/import/parsers/index.js';
import { toPreviewConnection } from '../../shared/import/normalize.js';
import type {
  ExistingImportHost,
  ExportOptions,
  ImportApplyRequest,
  ImportApplyResult,
  ImportDocument,
  ImportFormat,
  ImportPreview,
  ImportSourceFile,
  ImportedConnection,
  ImportedCredential
} from '../../shared/import/types.js';
import { supportedImportFormats } from '../../shared/import/types.js';
import {
  hostMetadataInputSchema,
  hostCredentialSchema,
  mergeConnectionProfileSettings,
  storedHostCredentialSchema,
  type HostCredentialInput,
  type StoredHostCredential
} from '../../shared/validation.js';
import { GroupRepository, HostRepository, type OwnerIdProvider, resolveOwnerId } from '../db/repositories.js';
import type { SqliteDatabase } from '../db/database.js';
import { VaultService, type EncryptedJson } from '../vault/vault-service.js';
import { VAULT_KEY_LENGTH } from '../vault/types.js';
import type { IdentityService } from '../identity/identity-service.js';

const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_FILES = 32;
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_CONNECTIONS = 10_000;

interface PendingPreview {
  expiresAt: number;
  sources: ImportPreview['sources'];
  connections: ResolvedImportedConnection[];
  groups: Array<{ path: string[]; sourceId: string }>;
  warnings: string[];
}

export interface SshImportServiceOptions {
  ownerId: OwnerIdProvider;
  database: SqliteDatabase;
  hostRepository: HostRepository;
  groupRepository: GroupRepository;
  vaultService: VaultService;
  identityService?: IdentityService;
  now?: () => number;
  previewTtlMs?: number;
}

const hostCredentialAad = (id: string): string => `host:${id}:credentials:v1`;

const assertSessionKey = (sessionKey: Buffer): void => {
  if (!Buffer.isBuffer(sessionKey) || sessionKey.length !== VAULT_KEY_LENGTH) throw new AppError('AUTH_REQUIRED');
};

const byteLength = (content: string | Uint8Array): number => typeof content === 'string' ? Buffer.byteLength(content, 'utf8') : content.byteLength;

const isZip = (file: ImportSourceFile): boolean => {
  if (typeof file.content === 'string') return false;
  return file.content[0] === 0x50 && file.content[1] === 0x4b;
};

const fileText = (content: string | Uint8Array): string => typeof content === 'string'
  ? content
  : new globalThis.TextDecoder('utf-8', { fatal: false }).decode(content);

const isPrivateKeyFile = (file: ImportSourceFile): boolean => {
  const basename = file.filename.split(/[\\/]/u).at(-1) ?? file.filename;
  return /^(?:id_[^./]+|.+\.(?:key|pem|ppk))$/iu.test(basename) || /^\s*-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/mu.test(fileText(file.content));
};

const isAuxiliaryImportFile = (file: ImportSourceFile): boolean => {
  const basename = file.filename.split(/[\\/]/u).at(-1) ?? file.filename;
  return /\.pub$/iu.test(basename) || /^known_hosts(?:\.[^.]*)?$/iu.test(basename);
};

const hydratePrivateKeys = (document: ImportDocument, files: readonly ImportSourceFile[]): ImportDocument => {
  const keyFiles = new Map<string, string>();
  for (const file of files) {
    if (!isPrivateKeyFile(file)) continue;
    const text = fileText(file.content);
    if (/-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/u.test(text)) {
      const basename = file.filename.split(/[\\/]/u).at(-1) ?? file.filename;
      keyFiles.set(file.filename, text);
      keyFiles.set(basename, text);
    }
  }
  if (keyFiles.size === 0) return document;
  return {
    ...document,
    connections: document.connections.map((connection) => {
      if (connection.credential || !connection.identityFile) return connection;
      const basename = connection.identityFile.split(/[\\/]/u).at(-1) ?? connection.identityFile;
      const privateKey = keyFiles.get(connection.identityFile) ?? keyFiles.get(basename);
      return privateKey
        ? { ...connection, credential: { type: 'private_key', privateKey, identityFile: connection.identityFile }, credentialState: 'ready' }
        : connection;
    })
  };
};

const namespaceDocument = (document: ImportDocument, index: number): ImportDocument => {
  const prefix = `${index}:${document.source.filename}:`;
  const sourceIds = new Map(document.connections.map((connection) => [connection.sourceId, `${prefix}${connection.sourceId}`]));
  const connections = document.connections.map((connection) => ({
    ...connection,
    sourceId: sourceIds.get(connection.sourceId) ?? `${prefix}${connection.sourceId}`,
    jumpHostSourceIds: connection.jumpHostSourceIds.map((reference) => sourceIds.get(reference) ?? reference)
  }));
  return {
    ...document,
    connections,
    groups: document.groups.map((group) => ({ ...group, sourceId: `${prefix}${group.sourceId}` }))
  };
};

const parseEncryptedCredential = (serialized: string): EncryptedJson => {
  try {
    const value: unknown = JSON.parse(serialized);
    if (typeof value !== 'object' || value === null || !('version' in value) || !('nonce' in value) || !('ciphertext' in value) || !('authTag' in value) || !('aad' in value)) throw new Error('credential');
    return value as EncryptedJson;
  } catch {
    throw new AppError('VAULT_CRYPTO_FAILED');
  }
};

const toExistingHost = (host: ReturnType<HostRepository['listMetadata']>[number]): ExistingImportHost => ({
  id: host.id,
  name: host.name,
  address: host.address,
  port: host.port,
  username: host.username,
  authType: host.authType,
  groupId: host.groupId
});

const credentialFromConnection = (connection: ImportedConnection, supplied: ImportedCredential | undefined): StoredHostCredential => {
  const candidate = supplied ?? connection.credential;
  if (!candidate) {
    return { type: 'pending', authType: connection.authType === 'private_key' ? 'private_key' : 'password' };
  }
  const parsed = hostCredentialSchema.safeParse(candidate);
  if (!parsed.success) throw new AppError('IMPORT_RECORD_INVALID');
  if (parsed.data.type === 'private_key' && connection.identityFile && !parsed.data.identityFile) {
    return { ...parsed.data, identityFile: connection.identityFile };
  }
  return parsed.data;
};

const toImportCredential = (credential: HostCredentialInput): ImportedCredential => credential.type === 'password'
  ? { type: 'password', password: credential.password }
  : { type: 'private_key', privateKey: credential.privateKey, ...(credential.passphrase === undefined ? {} : { passphrase: credential.passphrase }), ...(credential.identityFile === undefined ? {} : { identityFile: credential.identityFile }) };

const safeGroupName = (path: string[]): string | null => {
  const name = path.join(' / ').trim();
  return name.length > 0 && name.length <= 120 && ![...name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  }) ? name : null;
};

export class SshImportService {
  private get ownerId(): string { return resolveOwnerId(this.options.ownerId); }

  private readonly previews = new Map<string, PendingPreview>();
  private readonly now: () => number;
  private readonly previewTtlMs: number;

  constructor(private readonly options: SshImportServiceOptions) {
    this.now = options.now ?? Date.now;
    this.previewTtlMs = options.previewTtlMs ?? DEFAULT_PREVIEW_TTL_MS;
    if (!Number.isInteger(this.previewTtlMs) || this.previewTtlMs < 1000 || this.previewTtlMs > 24 * 60 * 60 * 1000) throw new AppError('IMPORT_APPLY_INVALID');
  }

  listFormats(): Array<{ id: ImportFormat; label: string; extensions: string[]; description: string }> {
    return supportedImportFormats.map((format) => ({ ...format, extensions: [...format.extensions] }));
  }

  async preview(files: readonly ImportSourceFile[], formatHint?: ImportFormat): Promise<ImportPreview> {
    this.prunePreviews();
    if (!Array.isArray(files) || files.length === 0 || files.length > MAX_FILES) throw new AppError('IMPORT_RECORD_INVALID');
    let totalBytes = 0;
    const expanded: ImportSourceFile[] = [];
    for (const file of files) {
      if (!file.filename || byteLength(file.content) > MAX_FILE_BYTES) throw new AppError('FILE_TOO_LARGE');
      totalBytes += byteLength(file.content);
      if (totalBytes > MAX_TOTAL_BYTES) throw new AppError('FILE_TOO_LARGE');
      if (isZip(file)) expanded.push(...await extractImportZip(file.content as Uint8Array));
      else expanded.push(file);
      if (expanded.length > MAX_FILES) throw new AppError('IMPORT_RECORD_INVALID');
    }
    const auxiliaryWarnings = expanded
      .filter((file) => isAuxiliaryImportFile(file))
      .map((file) => `${file.filename} 是辅助文件，当前仅导入连接配置，已跳过`);
    const sourceFiles = expanded.filter((file) => !isPrivateKeyFile(file) && !isAuxiliaryImportFile(file));
    const documents = sourceFiles.map((file, index) => namespaceDocument(hydratePrivateKeys(parseImportSource(file, formatHint), expanded), index));
    const allConnections = documents.flatMap((document) => document.connections);
    if (allConnections.length > MAX_CONNECTIONS) throw new AppError('IMPORT_RECORD_INVALID');
    const existingHosts = this.options.hostRepository.listMetadata().map(toExistingHost);
    const resolved = resolveImportConnections(allConnections, existingHosts);
    const groups = new Map<string, { path: string[]; sourceId: string }>();
    documents.flatMap((document) => document.groups).forEach((group) => {
      const key = group.path.join('\u001f');
      if (!groups.has(key)) groups.set(key, group);
    });
    const sourceList = documents.map((document) => document.source);
    const previewId = randomUUID();
    const expiresAt = this.now() + this.previewTtlMs;
    const existingGroupNames = new Set(this.options.groupRepository.list().map((group) => group.name));
    const groupConflicts = [...groups.values()].flatMap((group) => {
      const name = safeGroupName(group.path);
      return name && existingGroupNames.has(name)
        ? [{ kind: 'existing-group' as const, sourceIds: [group.sourceId], message: `已存在分组 ${name}，将复用现有分组` }]
        : [];
    });
    const warnings = [...auxiliaryWarnings, ...documents.flatMap((document) => document.warnings), ...resolved.warnings, ...groupConflicts.map((conflict) => conflict.message)];
    const conflicts = [...resolved.conflicts, ...groupConflicts];
    this.previews.set(previewId, { expiresAt, sources: sourceList, connections: resolved.connections, groups: [...groups.values()], warnings });
    const connections = resolved.connections.map((connection) => toPreviewConnection(connection, connection.credentialState, connection.conflicts));
    return {
      previewId,
      source: sourceList[0] ?? { filename: 'upload', format: formatHint ?? 'ssh-csv' },
      sources: sourceList,
      connectionCount: connections.length,
      groupCount: groups.size,
      connections,
      conflicts,
      warnings,
      expiresAt: new Date(expiresAt).toISOString()
    };
  }

  async apply(sessionKey: Buffer, previewId: string, request: ImportApplyRequest): Promise<ImportApplyResult> {
    assertSessionKey(sessionKey);
    this.prunePreviews();
    const pending = this.previews.get(previewId);
    if (!pending) throw new AppError('IMPORT_PREVIEW_EXPIRED');
    if (!request || !Array.isArray(request.selectedSourceIds) || !['skip', 'create', 'replace'].includes(request.conflictPolicy)) throw new AppError('IMPORT_APPLY_INVALID');
    const selectedIds = new Set(request.selectedSourceIds);
    if (selectedIds.size !== request.selectedSourceIds.length || selectedIds.size > MAX_CONNECTIONS) throw new AppError('IMPORT_APPLY_INVALID');
    const bySourceId = new Map(pending.connections.map((connection) => [connection.sourceId, connection]));
    if ([...selectedIds].some((id) => !bySourceId.has(id))) throw new AppError('IMPORT_APPLY_INVALID');
    const suppliedCredentials = new Map((request.credentials ?? []).map((item) => [item.sourceId, item.credential]));
    const existingRows = this.options.hostRepository.listMetadata();
    const existingHosts = existingRows.map(toExistingHost);
    const existingByKey = new Map(existingHosts.map((host) => [stableImportKey(host), host]));
    const sourceToHostId = new Map<string, string>();
    const skippedSourceIds = new Set<string>();
    const hostPlans: Array<{ connection: ResolvedImportedConnection; hostId: string; auth: StoredHostCredential; existing: ExistingImportHost | undefined }> = [];

    for (const connection of pending.connections) {
      const existing = existingByKey.get(stableImportKey(connection));
      if (existing && request.conflictPolicy === 'skip' && selectedIds.has(connection.sourceId)) {
        sourceToHostId.set(connection.sourceId, existing.id);
        skippedSourceIds.add(connection.sourceId);
        continue;
      }
      if (existing && !selectedIds.has(connection.sourceId)) {
        sourceToHostId.set(connection.sourceId, existing.id);
      }
      if (!selectedIds.has(connection.sourceId)) continue;
      if (connection.conflicts.some((conflict) => conflict.kind === 'unresolved-jump')) throw new AppError('IMPORT_RECORD_INVALID');
      const hostId = existing && request.conflictPolicy === 'replace' ? existing.id : randomUUID();
      const auth = credentialFromConnection(connection, suppliedCredentials.get(connection.sourceId));
      sourceToHostId.set(connection.sourceId, hostId);
      hostPlans.push({ connection, hostId, auth, existing });
    }

    const selectedConnections = pending.connections.filter((connection) => selectedIds.has(connection.sourceId));
    for (const connection of selectedConnections) {
      for (const jumpSourceId of connection.jumpHostSourceIds) {
        if (!sourceToHostId.has(jumpSourceId)) throw new AppError('IMPORT_RECORD_INVALID');
      }
    }
    const profiles = new Map(existingRows.map((host) => [host.id, { jumpHostIds: [...(host.jumpHostIds ?? [])] }]));
    for (const plan of hostPlans) {
      const jumpHostIds = plan.connection.jumpHostSourceIds.map((sourceId) => sourceToHostId.get(sourceId)).filter((id): id is string => Boolean(id));
      profiles.set(plan.hostId, { jumpHostIds });
      const parsed = hostMetadataInputSchema.safeParse({
        name: plan.connection.name,
        address: plan.connection.address,
        port: plan.connection.port,
        username: plan.connection.username,
        jumpHostIds,
        tags: plan.connection.tags,
        isFavorite: false
      });
      if (!parsed.success || !storedHostCredentialSchema.safeParse(plan.auth).success) throw new AppError('IMPORT_RECORD_INVALID');
    }
    for (const plan of hostPlans) {
      try {
        validateJumpChain(plan.hostId, profiles);
      } catch {
        throw new AppError('IMPORT_RECORD_INVALID', '导入的跳板机链无效或存在循环');
      }
    }

    const encryptedPlans = hostPlans.map((plan) => ({
      ...plan,
      credentialCiphertext: JSON.stringify(this.options.vaultService.encryptJson(sessionKey, hostCredentialAad(plan.hostId), plan.auth))
    }));
    const groupsByName = new Map(this.options.groupRepository.list().map((group) => [group.name, group]));
    const operation = this.options.database.transaction((): ImportApplyResult => {
      const groupIds = new Map<string, string>();
      let importedGroups = 0;
      let skippedGroups = 0;
      for (const plan of encryptedPlans) {
        const groupName = safeGroupName(plan.connection.groupPath);
        if (!groupName || groupIds.has(groupName)) continue;
        const existing = groupsByName.get(groupName);
        if (existing) {
          groupIds.set(groupName, existing.id);
          skippedGroups += 1;
        } else {
          const created = this.options.groupRepository.create({ name: groupName, sortOrder: this.options.groupRepository.list().length });
          groupIds.set(groupName, created.id);
          groupsByName.set(groupName, created);
          importedGroups += 1;
        }
      }
      let importedHosts = 0;
      for (const plan of encryptedPlans) {
        const groupId = safeGroupName(plan.connection.groupPath);
        const jumpHostIds = plan.connection.jumpHostSourceIds.map((sourceId) => sourceToHostId.get(sourceId)).filter((id): id is string => Boolean(id));
        const input = {
          name: plan.connection.name,
          address: plan.connection.address,
          port: plan.connection.port,
          username: plan.connection.username,
          authType: plan.auth.type === 'pending' ? plan.auth.authType : plan.auth.type,
          credentialCiphertext: plan.credentialCiphertext,
          credentialVersion: 1,
          hostKeyAlgorithm: null,
          hostKeyFingerprint: null,
          groupId: groupId ? groupIds.get(groupId) ?? null : null,
          tags: plan.connection.tags,
          isFavorite: false,
          lastConnectedAt: null,
          jumpHostIds,
          connectionProfile: mergeConnectionProfileSettings(undefined)
        };
        if (plan.existing && plan.hostId === plan.existing.id && request.conflictPolicy === 'replace') {
          this.options.hostRepository.updateHost(plan.hostId, {
            name: input.name,
            address: input.address,
            port: input.port,
            username: input.username,
            authType: input.authType,
            credentialCiphertext: input.credentialCiphertext,
            credentialVersion: input.credentialVersion,
            groupId: input.groupId,
            tags: input.tags,
            jumpHostIds: input.jumpHostIds,
            connectionProfile: input.connectionProfile,
            isFavorite: input.isFavorite
          });
        } else {
          this.options.hostRepository.createHost({ id: plan.hostId, ownerId: this.ownerId, ...input });
        }
        importedHosts += 1;
      }
      return { importedHosts, skippedHosts: skippedSourceIds.size, importedGroups, skippedGroups, warnings: pending.warnings };
    });
    const result = operation();
    this.clearPreview(previewId);
    return result;
  }

  async exportOpenSsh(sessionKey: Buffer): Promise<string> {
    assertSessionKey(sessionKey);
    const connections = await this.exportConnections(sessionKey, false);
    return exportOpenSshConfig(connections);
  }

  async exportCsv(sessionKey: Buffer, options: ExportOptions = {}): Promise<string> {
    assertSessionKey(sessionKey);
    if (options.includePasswords && !options.confirmPasswordExport) throw new AppError('IMPORT_APPLY_INVALID', '导出密码需要二次确认');
    const connections = await this.exportConnections(sessionKey, Boolean(options.includePasswords));
    return exportGenericCsv(connections, options);
  }

  private async exportConnections(sessionKey: Buffer, includePasswords: boolean): Promise<ImportedConnection[]> {
    const groups = new Map(this.options.groupRepository.list().map((group) => [group.id, group.name]));
    const rows = this.options.hostRepository.listForBundle();
    const groupNodes = this.options.groupRepository.list();
    const connections: ImportedConnection[] = [];
    for (const row of rows) {
      let credential: ImportedCredential | undefined;
      let decrypted: StoredHostCredential;
      const resolved = resolveConnectionConfiguration(row, groupNodes);
      const identityId = row.credentialSource?.type === 'identity'
        ? row.identityId
        : row.credentialSource?.type === 'group' ? resolved.identityId : null;
      if (identityId) {
        if (!this.options.identityService) throw new AppError('IDENTITY_NOT_FOUND');
        decrypted = await this.options.identityService.getCredential(this.ownerId, identityId, sessionKey);
      } else {
        if (row.credentialSource?.type === 'group') throw new AppError('IDENTITY_NOT_FOUND');
        if (row.credentialCiphertext === null) throw new AppError('IMPORT_RECORD_INVALID', '请先在连接时补录凭据');
        decrypted = await this.options.vaultService.decryptJson<StoredHostCredential>(sessionKey, hostCredentialAad(row.id), parseEncryptedCredential(row.credentialCiphertext));
      }
      const parsedCredential = storedHostCredentialSchema.safeParse(decrypted);
      if (!parsedCredential.success) throw new AppError('VAULT_CRYPTO_FAILED');
      const decryptedImportCredential = parsedCredential.data.type === 'pending' ? undefined : toImportCredential(parsedCredential.data);
      if (decryptedImportCredential && (includePasswords || decryptedImportCredential.type === 'private_key')) credential = decryptedImportCredential;
      connections.push({
        sourceId: `host:${row.id}`,
        name: row.name,
        address: row.address,
        port: row.port,
        username: row.username,
        authType: row.authType,
        credentialState: decryptedImportCredential ? 'ready' : 'needs-user-input',
        ...(decryptedImportCredential?.type === 'private_key' && decryptedImportCredential.identityFile ? { identityFile: decryptedImportCredential.identityFile, credentialSource: decryptedImportCredential.identityFile } : {}),
        ...(credential ? { credential } : {}),
        groupPath: row.groupId && groups.has(row.groupId) ? [groups.get(row.groupId) as string] : [],
        tags: [...row.tags],
        jumpHostSourceIds: (row.jumpHostIds ?? []).map((id) => `host:${id}`),
        notes: [],
        sourceFields: {}
      });
    }
    return connections;
  }

  private prunePreviews(): void {
    const now = this.now();
    for (const [id, pending] of this.previews) if (pending.expiresAt <= now) this.clearPreview(id);
  }

  private clearPreview(previewId: string): void {
    const pending = this.previews.get(previewId);
    if (!pending) return;
    for (const connection of pending.connections) delete connection.credential;
    this.previews.delete(previewId);
  }
}
