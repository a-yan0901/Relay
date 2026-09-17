import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import { AppError } from '../../src/shared/errors.js';
import type { NativeEventFrame } from '../../src/shared/native/bridge.js';
import type { ConnectionProfile, GroupNode, HostListFilter, TransferResumeRequest, WorkspaceState } from '../../src/shared/core/models.js';
import { connectionDiagnosticToOperationDiagnostic } from '../../src/shared/core/state-machines.js';
import { resolveConnectionConfiguration } from '../../src/shared/core/connection-resolution.js';
import type { HostCredentialInput, HostMetadata, StoredHostCredential } from '../../src/shared/validation.js';
import { defaultConnectionProfileSettings, mergeConnectionProfileSettings, parseHostCreateInput, parseHostPatchInput, storedHostCredentialSchema } from '../../src/shared/validation.js';
import { runWithOwnerId, currentOwnerId, DEFAULT_OWNER_ID } from '../../src/server/auth/owner-context.js';
import { SessionStore, type SessionRecord } from '../../src/server/auth/session-store.js';
import { openDatabase, type SqliteDatabase } from '../../src/server/db/database.js';
import type { HostRow } from '../../src/server/db/types.js';
import { migrate } from '../../src/server/db/migrations.js';
import { AppConfigRepository, AuditRepository, GroupRepository, HostRepository } from '../../src/server/db/repositories.js';
import { VaultService, type EncryptedJson } from '../../src/server/vault/vault-service.js';
import { IdentityService } from '../../src/server/identity/identity-service.js';
import { TerminalProfileService } from '../../src/server/terminal/terminal-profile-service.js';
import { WorkspaceRepository } from '../../src/server/workspace/workspace-repository.js';
import { WorkspaceService } from '../../src/server/workspace/workspace-service.js';
import { VaultBundleService } from '../../src/server/workspace/vault-bundle-service.js';
import { SshImportService } from '../../src/server/workspace/ssh-import-service.js';
import { ConnectionPathResolver } from '../../src/server/ssh/connection-path.js';
import { createConnectionResourceProvider } from '../../src/server/ssh/connection-resource-provider.js';
import { Ssh2Adapter, Ssh2ResourceAdapter } from '../../src/server/ssh/ssh2-adapter.js';
import { SshSessionManager } from '../../src/server/ssh/session-manager.js';
import type { SshAdapterPort, SshChannel, SshConnectCallbacks, SshConnectConfig } from '../../src/server/ssh/types.js';
import { HostKeyPolicy } from '../../src/server/ssh/host-key-policy.js';
import { SftpService, type SftpResourceProvider } from '../../src/server/sftp/sftp-service.js';
import { openSftpResource } from '../../src/server/sftp/sftp-adapter.js';
import { TransferManager } from '../../src/server/sftp/transfer-manager.js';
import { OperationEventBus } from '../../src/server/ws/operation-gateway.js';
import { SnippetService } from '../../src/server/automation/snippet-service.js';
import { CommandRunStore } from '../../src/server/automation/command-run-store.js';
import { CommandRunner } from '../../src/server/automation/command-runner.js';
import { AuditService } from '../../src/server/audit/audit-service.js';
import { DesktopIpcRouter } from './ipc-contract.js';

const LOCAL_OWNER_ID = DEFAULT_OWNER_ID;
const LOCAL_MAX_EVENT_SUBSCRIBERS = 16;
const LOCAL_EVENT_CHUNK_BYTES = 32 * 1024;
const LOCAL_MAX_DOWNLOAD_STREAMS = 4;
const LOCAL_MAX_RETAINED_SESSION_REQUESTS = 32;

export interface WindowsLocalSystemServices {
  clipboard?: {
    readText(): string | Promise<string>;
    writeText(text: string): void | Promise<void>;
  };
}

export interface WindowsLocalRuntimeOptions {
  dataDir: string;
  maxSessions?: number;
  outputBufferBytes?: number;
  database?: SqliteDatabase;
  closeDatabase?: boolean;
  sshAdapter?: SshAdapterPort;
  systemServices?: WindowsLocalSystemServices;
}

export interface WindowsLocalRuntimeHandle {
  router: DesktopIpcRouter;
  database: SqliteDatabase;
  sessionStore: SessionStore;
  subscribe(listener: (event: NativeEventFrame) => void): () => void;
  close(): Promise<void>;
}

interface LocalSession {
  id: string;
  hostId: string;
  channel: SshChannel;
  callbacks: SshConnectCallbacks;
  closed: boolean;
  exited: boolean;
  closing: boolean;
}

interface PendingShell {
  request: Record<string, unknown>;
  record: SessionRecord;
  hostId: string;
  credentials: Map<string, HostCredentialInput>;
  policies: Map<string, HostKeyPolicy>;
  pendingCredentialHostId?: string;
  pendingCredentialAuthType?: 'password' | 'private_key';
}

interface PreparedShell {
  host: HostRow;
  config: SshConnectConfig;
  policies: Map<string, HostKeyPolicy>;
}

interface DownloadState {
  iterator: AsyncIterator<Uint8Array>;
  pending: Uint8Array | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const text = (value: unknown): string => typeof value === 'string' ? value : '';

const toBase64Url = (value: Uint8Array): string => Buffer.from(value).toString('base64url');

const fromBase64Url = (value: string): Uint8Array => {
  if (!/^[A-Za-z0-9_-]*$/u.test(value) || value.length > 48 * 1024) throw new AppError('PROTOCOL_INVALID_MESSAGE');
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.byteLength > LOCAL_EVENT_CHUNK_BYTES) throw new AppError('FILE_TOO_LARGE');
  return new Uint8Array(bytes);
};

const parseEncryptedCredential = (value: string): EncryptedJson => {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed) || parsed.version !== 1 || typeof parsed.nonce !== 'string' || typeof parsed.ciphertext !== 'string' || typeof parsed.authTag !== 'string' || typeof parsed.aad !== 'string') throw new Error('invalid credential');
    return parsed as unknown as EncryptedJson;
  } catch {
    throw new AppError('VAULT_CRYPTO_FAILED');
  }
};

const serializeEncryptedCredential = (value: EncryptedJson): string => JSON.stringify(value);

const groupNode = (row: ReturnType<GroupRepository['get']>): GroupNode => {
  if (!row) throw new AppError('GROUP_NOT_FOUND');
  return {
    id: row.id,
    name: row.name,
    parentId: row.parentId,
    sortOrder: row.sortOrder,
    defaultIdentityId: row.defaultIdentityId,
    connectionProfile: row.connectionProfile
  };
};

const profileFromHost = (host: HostMetadata): ConnectionProfile => ({
  hostId: host.id,
  address: host.address,
  port: host.port,
  username: host.username,
  authType: host.authType,
  jumpHostIds: host.jumpHostIds ?? [],
  keepaliveIntervalMs: host.resolvedConnectionProfile?.keepaliveIntervalMs ?? host.connectionProfile?.keepaliveIntervalMs ?? defaultConnectionProfileSettings().keepaliveIntervalMs,
  keepaliveCountMax: host.resolvedConnectionProfile?.keepaliveCountMax ?? host.connectionProfile?.keepaliveCountMax ?? defaultConnectionProfileSettings().keepaliveCountMax,
  reconnect: host.resolvedConnectionProfile?.reconnect ?? host.connectionProfile?.reconnect ?? defaultConnectionProfileSettings().reconnect,
  hostKeyAlgorithm: host.hostKeyAlgorithm,
  hostKeyFingerprint: host.hostKeyFingerprint
});

const hostCredentialAad = (id: string): string => `host:${id}:credentials:v1`;

const safeEventPayload = (value: unknown): unknown => {
  try {
    const serialized = JSON.stringify(value) ?? '';
    if (Buffer.byteLength(serialized, 'utf8') <= 48 * 1024) return value;
  } catch {
    // Fall through to the stable error payload.
  }
  return { code: 'PROTOCOL_INVALID_MESSAGE', message: '原生事件超出大小限制' };
};

export const createWindowsLocalRuntime = (options: WindowsLocalRuntimeOptions): WindowsLocalRuntimeHandle => {
  if (!options.dataDir || options.dataDir === ':memory:') {
    if (options.dataDir !== ':memory:') throw new AppError('VAULT_CONFIG_INVALID');
  } else mkdirSync(resolve(options.dataDir), { recursive: true });
  const database = options.database ?? openDatabase(options.dataDir === ':memory:' ? ':memory:' : join(resolve(options.dataDir), 'relay.sqlite'));
  migrate(database);
  const closeDatabase = options.closeDatabase ?? options.database === undefined;
  const ownerProvider = currentOwnerId;
  const appConfigRepository = new AppConfigRepository(database);
  const sessionStore = new SessionStore({ idleTimeoutMs: 15 * 60 * 1000 });
  const vaultService = new VaultService();
  const hostRepository = new HostRepository(database, ownerProvider);
  const groupRepository = new GroupRepository(database, ownerProvider);
  const auditRepository = new AuditRepository(database, ownerProvider);
  const identityService = new IdentityService({ database, vaultService });
  const terminalProfileService = new TerminalProfileService({ database });
  const workspaceService = new WorkspaceService(new WorkspaceRepository(database));
  const snippetService = new SnippetService({ ownerId: ownerProvider, database, vaultService });
  const operationBus = new OperationEventBus();
  const auditService = new AuditService(auditRepository);
  const maxLocalSessions = options.maxSessions ?? 4;
  const sshSessionManager = new SshSessionManager({
    adapter: options.sshAdapter ?? new Ssh2Adapter(),
    maxSessions: maxLocalSessions,
    outputBufferBytes: options.outputBufferBytes ?? 64 * 1024
  });
  const connectionPathResolver = new ConnectionPathResolver({
    get: (id, ownerId) => ownerId === LOCAL_OWNER_ID ? hostRepository.getForConnection(id) : null,
    list: (ownerId) => ownerId === LOCAL_OWNER_ID ? hostRepository.listMetadata() : []
  });
  const connectionResourceProvider = createConnectionResourceProvider({
    ownerId: ownerProvider,
    hostRepository,
    connectionPathResolver,
    vaultService,
    groupRepository,
    identityService,
    adapter: new Ssh2ResourceAdapter()
  });
  const sftpResourceProvider: SftpResourceProvider = {
    open: async (hostId, sessionKey) => {
      if (!sessionKey) throw new AppError('SESSION_INVALID');
      const lease = await connectionResourceProvider.open(hostId, sessionKey);
      try {
        const resource = await openSftpResource(lease.resource);
        return { resource, close: async () => { resource.close(); await lease.close(); } };
      } catch (error) {
        await lease.close();
        throw error;
      }
    }
  };
  const sftpService = new SftpService({ ownerId: ownerProvider, hostLookup: { hasHost: (hostId, ownerId) => ownerId === LOCAL_OWNER_ID && hostRepository.getForConnection(hostId) !== null }, resourceProvider: sftpResourceProvider });
  const transferManager = new TransferManager({ resourceProvider: sftpResourceProvider, ownerId: ownerProvider, database });
  const commandRunner = new CommandRunner({
    ownerId: ownerProvider,
    hostLookup: { get: (hostId, ownerId) => ownerId === LOCAL_OWNER_ID ? hostRepository.listMetadata().find((host) => host.id === hostId) ?? null : null },
    resourceProvider: connectionResourceProvider,
    store: new CommandRunStore({ ownerId: ownerProvider, database, vaultService }),
    operationBus,
    onCompleted: async (run) => { await auditService.recordCommandSummary(run); }
  });
  const vaultBundleService = new VaultBundleService({ ownerId: ownerProvider, database, hostRepository, groupRepository, vaultService, identityService });
  const sshImportService = new SshImportService({ ownerId: ownerProvider, database, hostRepository, groupRepository, vaultService, identityService });

  let activeSessionId: string | null = null;
  let generation = 1;
  let sequence = 0;
  let closed = false;
  const eventListeners = new Set<(event: NativeEventFrame) => void>();
  const sessions = new Map<string, LocalSession>();
  const sessionRequests = new Map<string, Record<string, unknown>>();
  const pendingShells = new Map<string, PendingShell>();
  const sessionPolicies = new Map<string, Map<string, HostKeyPolicy>>();
  const downloads = new Map<string, DownloadState>();

  const emit = (kind: string, payload: unknown, ids: { sessionId?: string; transferId?: string } = {}): void => {
    if (closed) return;
    sequence += 1;
    const event: NativeEventFrame = { version: 1, generation, sequence, kind, ...ids, payload: safeEventPayload(payload) };
    for (const listener of eventListeners) {
      try { listener(event); } catch {
        // A renderer may disappear while an event is being forwarded; one
        // subscriber must not break the local SSH/session lifecycle.
      }
    }
  };

  const session = (): SessionRecord => {
    if (!activeSessionId) throw new AppError('VAULT_LOCKED');
    const record = sessionStore.get(activeSessionId);
    if (!record) {
      activeSessionId = null;
      throw new AppError('SESSION_EXPIRED');
    }
    return record;
  };

  const withOwner = <T>(callback: () => T): T => runWithOwnerId(LOCAL_OWNER_ID, callback);
  const withSession = async <T>(callback: (record: SessionRecord) => Promise<T> | T): Promise<T> => {
    const record = session();
    return withOwner(() => Promise.resolve(callback(record)));
  };

  const hostDependencies = {
    ownerId: LOCAL_OWNER_ID,
    hostRepository,
    groupRepository,
    sessionStore,
    vaultService,
    auditRepository,
    identityService,
    terminalProfileService,
    sshSessionManager
  };

  const decorateHost = async (row: HostMetadata): Promise<HostMetadata> => {
    const groups = groupRepository.list();
    const resolved = await import('../../src/shared/core/connection-resolution.js').then(({ resolveConnectionConfiguration }) => resolveConnectionConfiguration(row, groups));
    const identityId = resolved.identityId;
    const identity = identityId ? await identityService.get(LOCAL_OWNER_ID, identityId) : null;
    return {
      ...row,
      ...(identity ? { authType: identity.type, identityName: identity.name, identitySource: resolved.identitySource } : {}),
      resolvedConnectionProfile: resolved.profile
    };
  };

  const hostMetadata = async (id: string): Promise<HostMetadata> => {
    const row = hostRepository.getForConnection(id);
    if (!row) throw new AppError('HOST_NOT_FOUND');
    return decorateHost(row as unknown as HostMetadata);
  };

  const credentialForHost = async (
    row: HostRow,
    record: SessionRecord,
    sessionCredentials: Map<string, HostCredentialInput>
  ): Promise<{ credential: HostCredentialInput | null; authType: 'password' | 'private_key' }> => {
    const supplied = sessionCredentials.get(row.id);
    if (supplied) return { credential: supplied, authType: supplied.type };

    const groups = groupRepository.list();
    const resolved = resolveConnectionConfiguration(row, groups);
    const identityId = row.credentialSource?.type === 'identity'
      ? row.identityId
      : row.credentialSource?.type === 'group' ? resolved.identityId : null;
    if (identityId) {
      const identity = await identityService.get(LOCAL_OWNER_ID, identityId);
      if (!identity) throw new AppError('IDENTITY_NOT_FOUND');
      const credential = await identityService.getCredential(LOCAL_OWNER_ID, identityId, record.vaultKey);
      return credential.type === 'pending'
        ? { credential: null, authType: credential.authType }
        : { credential, authType: identity.type };
    }
    if (row.credentialSource?.type === 'group') throw new AppError('IDENTITY_NOT_FOUND');
    if (row.credentialCiphertext === null) return { credential: null, authType: row.authType };
    const stored = await vaultService.decryptJson<StoredHostCredential>(
      record.vaultKey,
      hostCredentialAad(row.id),
      parseEncryptedCredential(row.credentialCiphertext)
    );
    const parsed = storedHostCredentialSchema.safeParse(stored);
    if (!parsed.success) throw new AppError('VAULT_CRYPTO_FAILED');
    return parsed.data.type === 'pending'
      ? { credential: null, authType: parsed.data.authType }
      : { credential: parsed.data, authType: parsed.data.type };
  };

  const createHostKeyPolicy = (row: HostRow, hopIndex: number): HostKeyPolicy => new HostKeyPolicy({
    hostId: row.id,
    address: row.address,
    port: row.port,
    knownHostKey: row.hostKeyAlgorithm && row.hostKeyFingerprint
      ? { algorithm: row.hostKeyAlgorithm, fingerprint: row.hostKeyFingerprint }
      : null,
    hopIndex,
    saveHostKey: (hostId, algorithm, fingerprint) => hostRepository.setHostKey(hostId, algorithm, fingerprint)
  });

  const prepareShell = async (
    requestValue: Record<string, unknown>,
    record: SessionRecord,
    sessionCredentials: Map<string, HostCredentialInput>,
    policies = new Map<string, HostKeyPolicy>()
  ): Promise<{ pending: { host: HostRow; authType: 'password' | 'private_key'; policies: Map<string, HostKeyPolicy> } } | { prepared: PreparedShell }> => {
    const hostId = text(requestValue.hostId);
    const target = hostRepository.getForConnection(hostId);
    if (!target) throw new AppError('HOST_NOT_FOUND');
    const path = connectionPathResolver.resolve(target.id, LOCAL_OWNER_ID);
    const pathRows = path.hops.map((hop) => hostRepository.getForConnection(hop.id)).filter((candidate): candidate is HostRow => candidate !== null);
    if (pathRows.length !== path.hops.length) throw new AppError('HOST_NOT_FOUND');

    const pathConfigs: SshConnectConfig[] = [];
    for (const [hopIndex, row] of pathRows.entries()) {
      const policy = policies.get(row.id) ?? createHostKeyPolicy(row, hopIndex);
      policies.set(row.id, policy);
      const loaded = await credentialForHost(row, record, sessionCredentials);
      if (!loaded.credential) return { pending: { host: row, authType: loaded.authType, policies } };
      const resolved = resolveConnectionConfiguration(row, groupRepository.list());
      pathConfigs.push({
        hostId: row.id,
        address: row.address,
        port: row.port,
        username: row.username,
        auth: loaded.credential,
        hostKeyAlgorithm: row.hostKeyAlgorithm,
        hostKeyFingerprint: row.hostKeyFingerprint,
        keepaliveInterval: resolved.profile.keepaliveIntervalMs,
        keepaliveCountMax: resolved.profile.keepaliveCountMax,
        reconnect: resolved.profile.reconnect
      });
    }

    const targetConfig = pathConfigs.at(-1);
    if (!targetConfig) throw new AppError('CONNECTION_STAGE_FAILED');
    const cols = typeof requestValue.cols === 'number' ? requestValue.cols : 80;
    const rows = typeof requestValue.rows === 'number' ? requestValue.rows : 24;
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > 1000 || rows > 500) throw new AppError('PROTOCOL_INVALID_MESSAGE');
    return {
      prepared: {
        host: target,
        policies,
        config: {
          ...targetConfig,
          cols,
          rows,
          term: text(requestValue.term) || 'xterm-256color',
          ...(pathConfigs.length > 1 ? { jumpHosts: pathConfigs.slice(0, -1) } : {})
        }
      }
    };
  };

  const createHost = async (inputValue: unknown, record: SessionRecord): Promise<HostMetadata> => {
    const input = parseHostCreateInput(inputValue);
    const id = randomUUID();
    let authType: 'password' | 'private_key';
    let credentialCiphertext: string | null = null;
    let credentialSource: 'inline' | 'identity' | 'group' = 'inline';
    let identityId: string | null = null;
    if (input.credentialSource?.type === 'identity') {
      const identity = await identityService.get(LOCAL_OWNER_ID, input.credentialSource.identityId);
      if (!identity) throw new AppError('IDENTITY_NOT_FOUND');
      authType = identity.type;
      credentialSource = 'identity';
      identityId = identity.id;
    } else if (input.credentialSource?.type === 'group') {
      const group = groupRepository.get(input.groupId ?? '');
      if (!group?.defaultIdentityId) throw new AppError('IDENTITY_NOT_FOUND');
      const identity = await identityService.get(LOCAL_OWNER_ID, group.defaultIdentityId);
      if (!identity) throw new AppError('IDENTITY_NOT_FOUND');
      authType = identity.type;
      credentialSource = 'group';
    } else {
      if (!input.auth) throw new AppError('HOST_VALIDATION_FAILED');
      authType = input.auth.type;
      credentialCiphertext = serializeEncryptedCredential(await vaultService.encryptJson(record.vaultKey, hostCredentialAad(id), input.auth));
    }
    const created = hostRepository.createHost({ id, ownerId: LOCAL_OWNER_ID, name: input.name, address: input.address, port: input.port, username: input.username, authType, credentialCiphertext, credentialVersion: 1, credentialSource, identityId, hostKeyAlgorithm: null, hostKeyFingerprint: null, groupId: input.groupId ?? null, terminalProfileId: input.terminalProfileId ?? null, jumpHostIds: input.jumpHostIds, connectionProfile: mergeConnectionProfileSettings(input.connectionProfile), connectionProfileOverrides: input.connectionProfile ?? null, tags: input.tags, isFavorite: input.isFavorite, lastConnectedAt: null });
    return hostMetadata(created.id);
  };

  const updateHost = async (id: string, inputValue: unknown, record: SessionRecord): Promise<HostMetadata> => {
    const current = hostRepository.getForConnection(id);
    if (!current) throw new AppError('HOST_NOT_FOUND');
    const input = parseHostPatchInput(inputValue);
    const patch: Parameters<HostRepository['updateHost']>[1] = { name: input.name, address: input.address, port: input.port, username: input.username, groupId: input.groupId, terminalProfileId: input.terminalProfileId, jumpHostIds: input.jumpHostIds, tags: input.tags, isFavorite: input.isFavorite };
    const nextSource = input.credentialSource?.type ?? current.credentialSource?.type;
    if (input.connectionProfile !== undefined) {
      patch.connectionProfileOverrides = { ...(current.connectionProfileOverrides ?? {}), ...input.connectionProfile };
      patch.connectionProfile = mergeConnectionProfileSettings(patch.connectionProfileOverrides, current.connectionProfile ?? defaultConnectionProfileSettings());
    }
    if (input.credentialSource?.type === 'identity') {
      const identity = await identityService.get(LOCAL_OWNER_ID, input.credentialSource.identityId);
      if (!identity) throw new AppError('IDENTITY_NOT_FOUND');
      patch.authType = identity.type; patch.credentialSource = 'identity'; patch.identityId = identity.id; patch.credentialCiphertext = null; patch.credentialVersion = 1;
    } else if (input.auth !== undefined) {
      patch.authType = input.auth.type; patch.credentialSource = 'inline'; patch.identityId = null; patch.credentialVersion = 1; patch.credentialCiphertext = serializeEncryptedCredential(await vaultService.encryptJson(record.vaultKey, hostCredentialAad(id), input.auth));
    } else if (nextSource === 'group') {
      const group = groupRepository.get(input.groupId ?? current.groupId ?? '');
      if (!group?.defaultIdentityId) throw new AppError('IDENTITY_NOT_FOUND');
      const identity = await identityService.get(LOCAL_OWNER_ID, group.defaultIdentityId);
      if (!identity) throw new AppError('IDENTITY_NOT_FOUND');
      patch.authType = identity.type; patch.credentialSource = 'group'; patch.identityId = null; patch.credentialCiphertext = null; patch.credentialVersion = 1;
    }
    hostRepository.updateHost(id, patch);
    return hostMetadata(id);
  };

  const openShell = async (requestValue: unknown, record: SessionRecord): Promise<{ sessionId: string; hostId: string; pending?: boolean }> => {
    if (!isRecord(requestValue)) throw new AppError('PROTOCOL_INVALID_MESSAGE');
    const requestId = text(requestValue.requestId) || randomUUID();
    const normalizedRequest = { ...requestValue, requestId };
    const previous = sessions.get(requestId);
    if (previous) {
      previous.closed = true;
      previous.closing = true;
      sshSessionManager.close(requestId);
      sessions.delete(requestId);
      sessionPolicies.delete(requestId);
    }

    const pending = pendingShells.get(requestId);
    const credentials = pending?.credentials ?? new Map<string, HostCredentialInput>();
    if (!pending && !sessions.has(requestId) && pendingShells.size >= maxLocalSessions) throw new AppError('SSH_SESSION_LIMIT');
    const preparedResult = await prepareShell(normalizedRequest, record, credentials, pending?.policies);
    if ('pending' in preparedResult) {
      pendingShells.set(requestId, {
        request: normalizedRequest,
        record,
        hostId: preparedResult.pending.host.id,
        credentials,
        policies: preparedResult.pending.policies,
        pendingCredentialHostId: preparedResult.pending.host.id,
        pendingCredentialAuthType: preparedResult.pending.authType
      });
      emit('terminal.status', { state: 'awaiting-credential', serviceInstanceId: 'desktop-local' }, { sessionId: requestId });
      emit('terminal.credential-required', {
        hostId: preparedResult.pending.host.id,
        authType: preparedResult.pending.authType,
        name: preparedResult.pending.host.name,
        address: preparedResult.pending.host.address,
        port: preparedResult.pending.host.port,
        username: preparedResult.pending.host.username
      }, { sessionId: requestId });
      return { sessionId: requestId, hostId: preparedResult.pending.host.id, pending: true };
    }

    pendingShells.delete(requestId);
    const { host, config, policies } = preparedResult.prepared;
    sessionPolicies.set(requestId, policies);
    const callbacks: SshConnectCallbacks = {
      onStatus: (state) => emit('terminal.status', { state, serviceInstanceId: 'desktop-local' }, { sessionId: requestId }),
      onDiagnostic: (diagnostic) => emit('terminal.diagnostic', {
        diagnostic: connectionDiagnosticToOperationDiagnostic(diagnostic, { operationId: requestId, requestId })
      }, { sessionId: requestId }),
      onHostKey: async (challenge) => new Promise<boolean>((resolve) => {
        const policy = policies.get(challenge.hostId ?? host.id);
        if (!policy) {
          resolve(false);
          return;
        }
        policy.verifyFingerprint(challenge.fingerprint, challenge.algorithm, (accepted) => {
          if (!accepted && policy.hasMismatch) emit('terminal.error', { code: 'HOST_KEY_MISMATCH', message: '远程主机指纹与已保存指纹不一致' }, { sessionId: requestId });
          resolve(accepted);
        });
        const challengeToShow = policy.pendingChallenge;
        if (challengeToShow) {
          emit('terminal.status', { state: 'awaiting-host-key', serviceInstanceId: 'desktop-local' }, { sessionId: requestId });
          emit('terminal.host-key', challengeToShow, { sessionId: requestId });
        }
      })
    };

    let channel: SshChannel;
    try {
      channel = await sshSessionManager.open(requestId, config, callbacks);
    } catch (error) {
      sessionPolicies.delete(requestId);
      if ([...policies.values()].some((policy) => policy.hasMismatch)) throw new AppError('HOST_KEY_MISMATCH');
      throw error;
    }
    const local: LocalSession = { id: requestId, hostId: host.id, channel, callbacks, closed: false, exited: false, closing: false };
    sessions.set(requestId, local);
    if (!sessionRequests.has(requestId) && sessionRequests.size >= LOCAL_MAX_RETAINED_SESSION_REQUESTS) {
      const oldest = sessionRequests.keys().next().value;
      if (typeof oldest === 'string') sessionRequests.delete(oldest);
    }
    sessionRequests.set(requestId, normalizedRequest);
    channel.on('data', (data) => {
      for (let offset = 0; offset < data.byteLength; offset += LOCAL_EVENT_CHUNK_BYTES) {
        const chunk = data.subarray(offset, offset + LOCAL_EVENT_CHUNK_BYTES);
        emit('terminal.output', { stream: 'stdout', encoding: 'base64url', data: Buffer.from(chunk).toString('base64url') }, { sessionId: requestId });
      }
    });
    channel.on('stderr', (data) => {
      for (let offset = 0; offset < data.byteLength; offset += LOCAL_EVENT_CHUNK_BYTES) {
        const chunk = data.subarray(offset, offset + LOCAL_EVENT_CHUNK_BYTES);
        emit('terminal.output', { stream: 'stderr', encoding: 'base64url', data: Buffer.from(chunk).toString('base64url') }, { sessionId: requestId });
      }
    });
    channel.on('exit', (code, signal) => {
      local.exited = true;
      emit('terminal.exit', { code, ...(signal === undefined ? {} : { signal }) }, { sessionId: requestId });
    });
    channel.on('error', (error) => {
      emit('terminal.diagnostic', {
        diagnostic: {
          operationId: requestId,
          hostId: host.id,
          kind: 'terminal',
          stage: 'tcp',
          state: 'interrupted',
          retryable: true,
          nextAction: 'reopen',
          errorCode: 'SSH_CONNECTION_FAILED',
          startedAt: new Date().toISOString()
        }
      }, { sessionId: requestId });
      if (!local.closing && !local.exited) emit('terminal.status', { state: 'interrupted', serviceInstanceId: 'desktop-local' }, { sessionId: requestId });
      void error;
    });
    channel.on('close', () => {
      if (local.closed) return;
      local.closed = true;
      sessions.delete(requestId);
      sessionPolicies.delete(requestId);
      if (local.exited || local.closing) {
        emit('terminal.close', { clean: true }, { sessionId: requestId });
      } else {
        emit('terminal.status', { state: 'interrupted', serviceInstanceId: 'desktop-local' }, { sessionId: requestId });
        emit('terminal.close', { clean: false }, { sessionId: requestId });
      }
    });
    emit('terminal.status', { state: 'connected', serviceInstanceId: 'desktop-local' }, { sessionId: requestId });
    hostRepository.markConnected(host.id);
    return { sessionId: requestId, hostId: host.id };
  };

  const registerHandlers = (router: DesktopIpcRouter): void => {
    router.register('system.clipboard.readText', async () => {
      const clipboard = options.systemServices?.clipboard;
      if (!clipboard) throw new AppError('CAPABILITY_UNAVAILABLE');
      const value = await clipboard.readText();
      if (typeof value !== 'string' || value.length > 64 * 1024) throw new AppError('PROTOCOL_INVALID_MESSAGE');
      return value;
    });
    router.register('system.clipboard.writeText', async (payload) => {
      const clipboard = options.systemServices?.clipboard;
      if (!clipboard || !isRecord(payload) || typeof payload.text !== 'string') throw new AppError('CAPABILITY_UNAVAILABLE');
      await clipboard.writeText(payload.text);
    });
    router.register('vault.status', async () => ({ phase: appConfigRepository.get() === null ? 'uninitialized' : activeSessionId && sessionStore.get(activeSessionId) ? 'unlocked' : 'locked' }));
    router.register('vault.setup', async (payload) => {
      if (!isRecord(payload) || typeof payload.masterPassword !== 'string') throw new AppError('MASTER_PASSWORD_INVALID');
      if (appConfigRepository.get()) throw new AppError('SETUP_ALREADY_COMPLETE');
      const creation = await vaultService.create(payload.masterPassword);
      appConfigRepository.create(creation.config);
      activeSessionId = sessionStore.create(creation.vaultKey, LOCAL_OWNER_ID);
      return { phase: 'unlocked' };
    });
    router.register('vault.unlock', async (payload) => {
      if (!isRecord(payload) || typeof payload.masterPassword !== 'string') throw new AppError('MASTER_PASSWORD_INVALID');
      const config = appConfigRepository.get();
      if (!config) throw new AppError('VAULT_NOT_INITIALIZED');
      sessionStore.revokeAll();
      const key = await vaultService.unlock(payload.masterPassword, config.vaultConfig);
      activeSessionId = sessionStore.create(key, LOCAL_OWNER_ID);
      return { phase: 'unlocked' };
    });
    router.register('vault.lock', async () => { sessionStore.revokeAll(); activeSessionId = null; });

    router.register('hosts.list', (payload) => withSession(async () => {
      const filter = isRecord(payload) ? payload as HostListFilter : {};
      return Promise.all(hostRepository.listMetadata(filter).map((host) => decorateHost(host)));
    }));
    router.register('hosts.get', (payload) => withSession(async () => hostMetadata(text(isRecord(payload) ? payload.id : ''))));
    router.register('hosts.listProfiles', () => withSession(async () => Promise.all(hostRepository.listMetadata().map((host) => decorateHost(host).then(profileFromHost)))));
    router.register('hosts.getProfile', (payload) => withSession(async () => profileFromHost(await hostMetadata(text(isRecord(payload) ? payload.hostId : '')))));
    router.register('hosts.create', (payload) => withSession(async (record) => createHost(isRecord(payload) ? payload.input : undefined, record)));
    router.register('hosts.update', (payload) => withSession(async (record) => { if (!isRecord(payload)) throw new AppError('HOST_NOT_FOUND'); return updateHost(text(payload.id), payload.input, record); }));
    router.register('hosts.delete', (payload) => withSession(async () => { const id = text(isRecord(payload) ? payload.id : ''); if (!hostRepository.getForConnection(id)) throw new AppError('HOST_NOT_FOUND'); hostRepository.deleteHost(id); sshSessionManager.closeForHost(id); }));
    router.register('hosts.clearHostKey', (payload) => withSession(async () => { const id = text(isRecord(payload) ? payload.id : ''); hostRepository.clearHostKey(id); }));
    router.register('connection.test', (payload) => withSession(async (record) => {
      const id = text(isRecord(payload) ? payload.hostId : '');
      const row = hostRepository.getForConnection(id);
      if (!row) throw new AppError('HOST_NOT_FOUND');
      const config = await (await import('../../src/server/api/host-routes.js')).toSshConfig(hostDependencies, record.vaultKey, row);
      let challenge: unknown;
      const result = await sshSessionManager.testConnection(config, { onHostKey: async (next) => { challenge = next; return Boolean(row.hostKeyFingerprint); } });
      return challenge ? { ok: false, hostKey: challenge } : result;
    }));

    router.register('identities.list', () => withSession(async () => identityService.list(LOCAL_OWNER_ID)));
    router.register('identities.get', (payload) => withSession(async () => identityService.get(LOCAL_OWNER_ID, text(isRecord(payload) ? payload.id : ''))));
    router.register('identities.create', (payload) => withSession(async (record) => identityService.create(LOCAL_OWNER_ID, (isRecord(payload) ? payload.input : undefined) as never, record.vaultKey)));
    router.register('identities.update', (payload) => withSession(async (record) => { if (!isRecord(payload)) throw new AppError('IDENTITY_NOT_FOUND'); return identityService.update(LOCAL_OWNER_ID, text(payload.id), (payload.input ?? {}) as never, record.vaultKey); }));
    router.register('identities.delete', (payload) => withSession(async () => identityService.delete(LOCAL_OWNER_ID, text(isRecord(payload) ? payload.id : ''))));

    router.register('groups.list', () => withSession(async () => groupRepository.list().map((row) => groupNode(row))));
    router.register('groups.get', (payload) => withSession(async () => groupNode(groupRepository.get(text(isRecord(payload) ? payload.id : '')))));
    router.register('groups.create', (payload) => withSession(async () => groupNode(groupRepository.create((isRecord(payload) ? payload.input : {}) as never))));
    router.register('groups.update', (payload) => withSession(async () => { if (!isRecord(payload)) throw new AppError('GROUP_NOT_FOUND'); return groupNode(groupRepository.update(text(payload.id), (payload.input ?? {}) as never)); }));
    router.register('groups.delete', (payload) => withSession(async () => groupRepository.delete(text(isRecord(payload) ? payload.id : ''))));

    router.register('workspace.load', () => withSession(async () => workspaceService.load(LOCAL_OWNER_ID)));
    router.register('workspace.save', (payload) => withSession(async () => { if (!isRecord(payload) || typeof payload.expectedVersion !== 'number') throw new AppError('WORKSPACE_INVALID'); return workspaceService.save(LOCAL_OWNER_ID, payload.expectedVersion, payload.state as WorkspaceState).state; }));
    router.register('workspace.listTemplates', () => withSession(async () => workspaceService.listTemplates(LOCAL_OWNER_ID)));
    router.register('workspace.createTemplate', (payload) => withSession(async () => { if (!isRecord(payload) || !isRecord(payload.input)) throw new AppError('WORKSPACE_INVALID'); const input = payload.input; return workspaceService.createTemplate(LOCAL_OWNER_ID, text(input.name), input.state as WorkspaceState); }));
    router.register('workspace.deleteTemplate', (payload) => withSession(async () => workspaceService.deleteTemplate(LOCAL_OWNER_ID, text(isRecord(payload) ? payload.id : ''))));

    router.register('terminalProfiles.list', () => withSession(async () => terminalProfileService.list(LOCAL_OWNER_ID)));
    router.register('terminalProfiles.getDefault', () => withSession(async () => terminalProfileService.getDefault(LOCAL_OWNER_ID)));
    router.register('terminalProfiles.create', (payload) => withSession(async () => terminalProfileService.create(LOCAL_OWNER_ID, isRecord(payload) ? payload.input : undefined)));
    router.register('terminalProfiles.setDefault', (payload) => withSession(async () => terminalProfileService.setDefault(LOCAL_OWNER_ID, text(isRecord(payload) ? payload.id : ''))));
    router.register('terminalProfiles.delete', (payload) => withSession(async () => terminalProfileService.delete(LOCAL_OWNER_ID, text(isRecord(payload) ? payload.id : ''))));

    router.register('sessions.openShell', (payload) => withSession((record) => openShell(isRecord(payload) ? payload.request : undefined, record)));
    router.register('sessions.reconnect', (payload) => withSession(async (record) => { const id = text(isRecord(payload) ? payload.sessionId : ''); const existing = sessions.get(id); if (existing && !existing.closed) return { sessionId: id, hostId: existing.hostId }; const request = sessionRequests.get(id); if (!request) throw new AppError('SESSION_NEEDS_REOPEN'); return openShell(request, record); }));
    router.register('sessions.write', (payload) => withSession(async () => {
      if (!isRecord(payload)) throw new AppError('SESSION_INVALID');
      const local = sessions.get(text(payload.sessionId));
      if (!local || local.closed) throw new AppError('SESSION_INVALID');
      local.channel.write(text(payload.data));
    }));
    router.register('sessions.resize', (payload) => withSession(async () => {
      if (!isRecord(payload)) throw new AppError('SESSION_INVALID');
      const local = sessions.get(text(payload.sessionId));
      if (!local || local.closed) throw new AppError('SESSION_INVALID');
      local.channel.resize(Number(payload.cols), Number(payload.rows));
    }));
    router.register('sessions.hostKeyDecision', (payload) => withSession(async () => {
      if (!isRecord(payload)) throw new AppError('SESSION_INVALID');
      const id = text(payload.sessionId);
      const policies = sessionPolicies.get(id) ?? pendingShells.get(id)?.policies;
      const policy = policies ? [...policies.values()].find((candidate) => candidate.pendingChallenge?.fingerprint === text(payload.fingerprint)) : undefined;
      if (!policy) throw new AppError('PROTOCOL_INVALID_MESSAGE');
      return { accepted: policy.decide(payload.decision === 'trust' ? 'trust' : 'reject', text(payload.fingerprint)) };
    }));
    router.register('sessions.credential', (payload) => withSession(async (record) => {
      if (!isRecord(payload) || !isRecord(payload.credential)) throw new AppError('SESSION_INVALID');
      const id = text(payload.sessionId);
      const pending = pendingShells.get(id);
      if (!pending || pending.pendingCredentialHostId !== text(payload.hostId)) throw new AppError('PROTOCOL_INVALID_MESSAGE');
      const credential = storedHostCredentialSchema.safeParse(payload.credential);
      if (!credential.success || credential.data.type === 'pending' || credential.data.type !== pending.pendingCredentialAuthType) throw new AppError('PROTOCOL_INVALID_MESSAGE');
      pending.credentials.set(text(payload.hostId), credential.data);
      pending.pendingCredentialHostId = undefined;
      pending.pendingCredentialAuthType = undefined;
      return openShell(pending.request, record);
    }));
    router.register('sessions.close', (payload) => withSession(async () => {
      const id = text(isRecord(payload) ? payload.sessionId : '');
      const pending = pendingShells.get(id);
      if (pending) pendingShells.delete(id);
      const local = sessions.get(id);
      if (local) {
        local.closed = true;
        local.closing = true;
        sshSessionManager.close(id);
        sessions.delete(id);
      }
      sessionPolicies.delete(id);
      sessionRequests.delete(id);
      emit('terminal.close', { clean: true }, { sessionId: id });
    }));

    router.register('files.list', (payload) => withSession(async (record) => { if (!isRecord(payload)) throw new AppError('SFTP_PATH_INVALID'); return sftpService.listEntries(text(payload.hostId), text(payload.path), record.vaultKey); }));
    router.register('files.createDirectory', (payload) => withSession(async (record) => { if (!isRecord(payload)) throw new AppError('SFTP_PATH_INVALID'); await sftpService.createDirectory(text(payload.hostId), text(payload.path), record.vaultKey); }));
    router.register('files.rename', (payload) => withSession(async (record) => { if (!isRecord(payload)) throw new AppError('SFTP_PATH_INVALID'); await sftpService.renameEntry(text(payload.hostId), text(payload.from), text(payload.to), record.vaultKey); }));
    router.register('files.remove', (payload) => withSession(async (record) => { if (!isRecord(payload)) throw new AppError('SFTP_PATH_INVALID'); await sftpService.removeEntry(text(payload.hostId), text(payload.path), true, record.vaultKey); }));
    router.register('files.createTransfer', (payload) => withSession(async () => transferManager.create((isRecord(payload) ? payload.request : undefined) as never)));
    router.register('files.listTransfers', () => withSession(async () => transferManager.list()));
    router.register('files.getTransfer', (payload) => withSession(async () => transferManager.get(text(isRecord(payload) ? payload.transferId : ''))));
    router.register('files.upload', (payload) => withSession(async (record) => {
      if (!isRecord(payload) || !isRecord(payload.resume) || typeof payload.data !== 'string' || typeof payload.nextChecksum !== 'string' || typeof payload.final !== 'boolean') throw new AppError('TRANSFER_RESUME_INVALID');
      const resume = payload.resume as unknown as TransferResumeRequest;
      const data = fromBase64Url(payload.data);
      const job = await transferManager.consumeUploadChunk(text(payload.transferId), (async function* () { yield data; })(), (updated) => emit('transfer.progress', { job: updated }, { transferId: updated.id }), record.vaultKey, resume, payload.nextChecksum, payload.final);
      return job;
    }));
    router.register('files.download', (payload) => withSession(async (record) => {
      if (!isRecord(payload)) throw new AppError('TRANSFER_NOT_FOUND');
      const id = text(payload.transferId);
      let state = downloads.get(id);
      if (!state) {
        if (downloads.size >= LOCAL_MAX_DOWNLOAD_STREAMS) throw new AppError('SFTP_TRANSFER_FAILED', '同时下载任务过多，请稍后重试');
        const stream = await transferManager.streamDownload(id, record.vaultKey, (updated) => emit('transfer.progress', { job: updated }, { transferId: updated.id }), payload.resume as TransferResumeRequest | undefined);
        state = { iterator: stream[Symbol.asyncIterator](), pending: null };
        downloads.set(id, state);
      }
      let chunk: Uint8Array | null = state.pending;
      state.pending = null;
      if (!chunk) {
        const next = await state.iterator.next();
        if (next.done) { downloads.delete(id); return { data: '', done: true }; }
        chunk = next.value;
      }
      const output = chunk.byteLength > LOCAL_EVENT_CHUNK_BYTES ? chunk.slice(0, LOCAL_EVENT_CHUNK_BYTES) : chunk;
      state.pending = chunk.byteLength > output.byteLength ? chunk.slice(output.byteLength) : null;
      return { data: toBase64Url(output), done: false };
    }));
    router.register('files.pauseTransfer', (payload) => withSession(async (record) => transferManager.pause(text(isRecord(payload) ? payload.transferId : ''), record.vaultKey)));
    router.register('files.cancelTransfer', (payload) => withSession(async (record) => transferManager.cancel(text(isRecord(payload) ? payload.transferId : ''), record.vaultKey)));
    router.register('files.retryTransfer', (payload) => withSession(async () => transferManager.retry(text(isRecord(payload) ? payload.transferId : ''))));

    router.register('commands.start', (payload) => withSession(async (record) => commandRunner.start(isRecord(payload) ? payload.request : undefined, record.vaultKey, randomUUID())));
    router.register('commands.get', (payload) => withSession(async (record) => commandRunner.get(text(isRecord(payload) ? payload.runId : ''), record.vaultKey)));
    router.register('commands.cancel', (payload) => withSession(async () => commandRunner.cancel(text(isRecord(payload) ? payload.runId : ''))));
    router.register('snippets.list', () => withSession(async () => snippetService.list()));
    router.register('snippets.get', (payload) => withSession(async (record) => snippetService.get(text(isRecord(payload) ? payload.id : ''), record.vaultKey)));
    router.register('snippets.create', (payload) => withSession(async (record) => snippetService.create(isRecord(payload) ? payload.input : undefined, record.vaultKey)));
    router.register('snippets.update', (payload) => withSession(async (record) => { if (!isRecord(payload)) throw new AppError('SNIPPET_NOT_FOUND'); return snippetService.update(text(payload.id), payload.input, record.vaultKey); }));
    router.register('snippets.delete', (payload) => withSession(async () => snippetService.delete(text(isRecord(payload) ? payload.id : ''))));
    router.register('activity.list', (payload) => withSession(async () => auditService.list(isRecord(payload) && isRecord(payload.filter) ? payload.filter as never : {})));

    router.register('imports.previewExternalImport', (payload) => withSession(async () => {
      if (!isRecord(payload) || !Array.isArray(payload.files)) throw new AppError('IMPORT_RECORD_INVALID');
      const files = payload.files.map((file) => {
        if (!isRecord(file) || typeof file.filename !== 'string' || typeof file.content !== 'string') throw new AppError('IMPORT_RECORD_INVALID');
        return { filename: file.filename, content: file.encoding === 'base64' ? fromBase64Url(file.content) : file.content };
      });
      return sshImportService.preview(files, text(payload.formatHint) as never);
    }));
    router.register('imports.applyExternalImport', (payload) => withSession(async (record) => { if (!isRecord(payload)) throw new AppError('IMPORT_APPLY_INVALID'); return sshImportService.apply(record.vaultKey, text(payload.previewId), (payload.input ?? {}) as never); }));
    router.register('imports.exportOpenSshConfig', () => withSession(async (record) => ({ data: toBase64Url(Buffer.from(await sshImportService.exportOpenSsh(record.vaultKey), 'utf8')) })));
    router.register('imports.exportCsv', (payload) => withSession(async (record) => ({ data: toBase64Url(Buffer.from(await sshImportService.exportCsv(record.vaultKey, (isRecord(payload) ? payload.options : {}) as never), 'utf8')) })));
    router.register('imports.exportVaultBundle', (payload) => withSession(async (record) => ({ bundle: await vaultBundleService.export(record.vaultKey, text(isRecord(payload) ? payload.exportPassword : '')) })));
    router.register('imports.previewVaultImport', (payload) => withSession(async (record) => { if (!isRecord(payload)) throw new AppError('VAULT_BUNDLE_INVALID'); return vaultBundleService.previewImport(record.vaultKey, text(payload.exportPassword), text(payload.bundle)); }));
    router.register('imports.applyVaultImport', (payload) => withSession(async (record) => { if (!isRecord(payload)) throw new AppError('VAULT_BUNDLE_INVALID'); return vaultBundleService.applyImport(record.vaultKey, text(payload.previewId), (payload.resolution ?? {}) as never); }));
  };

  const router = new DesktopIpcRouter();
  withOwner(() => registerHandlers(router));
  const stopOperationEvents = operationBus.subscribe(LOCAL_OWNER_ID, (event) => {
    if (event.type === 'transfer') emit('transfer.progress', { job: event.job }, { transferId: event.job.id });
    if (event.type === 'command-run') emit('command.progress', { run: event.run }, { transferId: undefined });
    if (event.type === 'diagnostic') emit('operation.diagnostic', { diagnostic: event.diagnostic });
  });

  return {
    router,
    database,
    sessionStore,
    subscribe(listener) {
      if (eventListeners.size >= LOCAL_MAX_EVENT_SUBSCRIBERS) throw new Error('local event subscriber limit reached');
      eventListeners.add(listener);
      return () => eventListeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      generation += 1;
      sessionStore.revokeAll();
      activeSessionId = null;
      pendingShells.clear();
      sessionPolicies.clear();
      stopOperationEvents();
      for (const id of sessions.keys()) sshSessionManager.close(id);
      sessions.clear();
      for (const state of downloads.values()) await state.iterator.return?.();
      downloads.clear();
      sshSessionManager.closeAll();
      eventListeners.clear();
      if (closeDatabase) database.close();
    }
  };
};
