import { AppError, isAppErrorCode } from '@shared/errors';
import type { AccountSession, ActivityFilter, AuditEvent, Capability, ClientPlatform, CommandRun, CommandRunRequest, ConnectionTestResult as SharedConnectionTestResult, DeviceDescriptor, GroupNode, HostListFilter, IdentityMetadata, RecoveryKeyState, SftpEntry, Snippet, SnippetMetadata, SyncConflictExport, SyncDescriptor, SyncEnvelope, SyncHead, SyncPreview, SyncResolution, SyncState, SyncStatus, TransferJob, TransferResumeRequest, VaultRecoveryPreview, WorkspaceState, WorkspaceTemplate } from '@shared/core/models';
import { parseSyncConflictExport } from '@shared/core/sync-conflict-export';
import type { GroupPatchInput, GroupMutationInput, HostCreateInput, HostMetadata, HostPatchInput, IdentityCreateInput, IdentityUpdateInput } from '@shared/validation';
import type { ExportOptions, ImportApplyRequest, ImportFormat, ImportPreview } from '@shared/import/types';
import type { VaultRecoveryInput } from '@shared/core/ports';

export interface SetupStatus {
  initialized: boolean;
  locked: boolean;
}

export interface CapabilityResponse {
  client: ClientPlatform;
  version: 1;
  capabilities: Capability[];
  limits?: {
    maxWorkspacePanes?: number;
    /** @deprecated Older servers called this limit maxPanes. */
    maxPanes?: number;
  };
}

export interface AccountSessionResponse {
  account: AccountSession | null;
}

export interface AccountAuthResponse {
  account: AccountSession;
}

export interface WebAccountApi {
  getAccountSession(): Promise<AccountSessionResponse>;
  register(email: string, password: string, deviceLabel?: string): Promise<AccountAuthResponse>;
  signIn(email: string, password: string, deviceLabel?: string): Promise<AccountAuthResponse>;
  signOut(): Promise<void>;
  listDevices(): Promise<DeviceDescriptor[]>;
  revokeDevice(deviceId: string): Promise<void>;
}

export interface WebSyncStateResponse {
  sync: SyncStatus;
  head: SyncHead | null;
  pendingCount?: number;
  lastError?: string;
  lastErrorCode?: string;
  lastSyncedAt?: string;
  recovery?: RecoveryKeyState;
  deletion?: SyncState['deletion'];
}

/** The plaintext key is a Web-only, one-time response and never a shared DTO. */
export interface WebRecoveryKeyIssueResponse {
  recoveryKey: string;
  keyVersion: number;
  status: 'pending-confirmation';
  recovery: RecoveryKeyState;
}

export interface WebSyncApi {
  getSyncState(): Promise<WebSyncStateResponse>;
  getSyncDescriptor(): Promise<SyncDescriptor | null>;
  enableSync(): Promise<SyncHead>;
  issueRecoveryKey(): Promise<WebRecoveryKeyIssueResponse>;
  confirmRecoveryKey(recoveryKey: string): Promise<RecoveryKeyState>;
  retrySync(): Promise<void>;
  previewPull(): Promise<SyncPreview>;
  exportConflict(conflictId: string, exportPassword: string): Promise<SyncConflictExport>;
  resolveConflict(conflictId: string, resolution: SyncResolution): Promise<void>;
}

export interface WebVaultRecoveryApi {
  previewSyncRecovery(input: VaultRecoveryInput): Promise<VaultRecoveryPreview>;
  applySyncRecovery(previewId: string, input: VaultRecoveryInput): Promise<SetupStatus>;
}

export type GroupSummaryResponse = GroupNode;
export type ConnectionTestResult = SharedConnectionTestResult;

export interface WorkspaceResponse extends WorkspaceState {}

export interface ImportPreviewResponse {
  previewId: string;
  hostCount: number;
  groupCount: number;
  identityCount?: number;
  conflicts: Array<{ type: 'host' | 'group' | 'identity'; id: string; name: string }>;
  expiresAt: string;
}

export interface ImportResultResponse {
  importedHosts: number;
  importedGroups: number;
  skippedHosts: number;
  skippedGroups: number;
  importedIdentities?: number;
  skippedIdentities?: number;
}

export type ExternalImportPreviewResponse = ImportPreview;

export interface ExternalImportResultResponse {
  importedHosts: number;
  skippedHosts: number;
  importedGroups: number;
  skippedGroups: number;
  warnings: string[];
}

export type SnippetResponse = Snippet;
export type CommandRunResponse = CommandRun;

export interface AuditEventsResponse {
  items: AuditEvent[];
  nextCursor?: string;
}

export type WorkspaceTemplateResponse = WorkspaceTemplate;
export type IdentityResponse = IdentityMetadata;

interface ApiErrorBody {
  error?: {
    code?: unknown;
    message?: unknown;
  };
}

const REQUEST_TIMEOUT_MS = 15_000;

const parseErrorBody = async (response: Response): Promise<ApiErrorBody> => {
  try {
    return await response.json() as ApiErrorBody;
  } catch {
    return {};
  }
};

type RequestOptions = {
  method?: string;
  headers?: Headers;
  body?: string | Blob | FormData | ReadableStream<Uint8Array>;
  acceptedStatuses?: readonly number[];
  responseType?: 'json' | 'blob' | 'stream';
  /** Streaming transfers must not be aborted by the short control-request timeout. */
  timeoutMs?: number | null;
  duplex?: 'half';
};

const isReadableStream = (value: unknown): value is ReadableStream<Uint8Array> => (
  typeof value === 'object' && value !== null && typeof (value as { getReader?: unknown }).getReader === 'function'
);

const request = async <T>(url: string, init: RequestOptions = {}): Promise<T> => {
  const headers = new Headers(init.headers);
  if (typeof init.body === 'string' && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const { acceptedStatuses = [], responseType = 'json', timeoutMs = REQUEST_TIMEOUT_MS, duplex, ...fetchOptions } = init;
  const controller = new AbortController();
  const timeout = timeoutMs === null ? undefined : setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...fetchOptions,
      headers,
      credentials: 'same-origin',
      signal: controller.signal,
      ...(duplex === undefined && isReadableStream(init.body) ? { duplex: 'half' as const } : duplex === undefined ? {} : { duplex })
    } as Parameters<typeof fetch>[1] & { duplex?: 'half' });

    if (!response.ok && !acceptedStatuses.includes(response.status)) {
      const body = await parseErrorBody(response);
      const candidateCode = body.error?.code;
      const code = typeof candidateCode === 'string' && isAppErrorCode(candidateCode)
        ? candidateCode
        : 'INTERNAL_ERROR';
      const message = typeof body.error?.message === 'string' ? body.error.message : '请求失败';
      throw new AppError(code, message, response.status);
    }

    if (response.status === 204) {
      return undefined as T;
    }
    if (responseType === 'blob') return await response.blob() as T;
    if (responseType === 'stream') {
      return (response.body ?? new ReadableStream<Uint8Array>()) as T;
    }
    return await response.json() as T;
  } catch (error) {
    if (controller.signal.aborted) {
      throw new AppError('INTERNAL_ERROR', '请求超时，请稍后重试', 408);
    }
    throw error;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
};

const json = (value: unknown): RequestOptions => ({ body: JSON.stringify(value) });

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const invalidResponse = (): never => {
  throw new AppError('PROTOCOL_INVALID_MESSAGE', '服务返回的数据格式无效');
};

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

const isInteger = (value: unknown): value is number => Number.isInteger(value);
const MAX_SYNC_KEY_VERSION = 32;

const isIsoDate = (value: unknown): value is string => isNonEmptyString(value) && Number.isFinite(Date.parse(value));

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const expected = new Set(keys);
  return Object.keys(value).length === expected.size && Object.keys(value).every((key) => expected.has(key));
};

const parseAccountSession = (value: unknown): AccountSession => {
  if (!isRecord(value)
    || !hasExactKeys(value, ['accountId', 'deviceId', 'state', 'expiresAt'])
    || !isNonEmptyString(value.accountId)
    || !isNonEmptyString(value.deviceId)
    || (value.state !== 'signed-in' && value.state !== 'revoked')
    || !isIsoDate(value.expiresAt)) return invalidResponse();
  return {
    accountId: value.accountId,
    deviceId: value.deviceId,
    state: value.state,
    expiresAt: value.expiresAt
  };
};

const parseAccountSessionResponse = (value: unknown): AccountSessionResponse => {
  if (!isRecord(value) || !hasExactKeys(value, ['account']) || (value.account !== null && value.account !== undefined && !isRecord(value.account))) return invalidResponse();
  return { account: value.account === null || value.account === undefined ? null : parseAccountSession(value.account) };
};

const parseAccountAuthResponse = (value: unknown): AccountAuthResponse => {
  if (!isRecord(value) || !hasExactKeys(value, ['account'])) return invalidResponse();
  return { account: parseAccountSession(value.account) };
};

const parseDevice = (value: unknown): DeviceDescriptor => {
  if (!isRecord(value)
    || !hasExactKeys(value, ['id', 'label', 'platform', 'lastSeenAt', 'current', 'revokedAt'])
    || !isNonEmptyString(value.id)
    || !isNonEmptyString(value.label)
    || (value.platform !== 'web' && value.platform !== 'desktop' && value.platform !== 'android')
    || (value.lastSeenAt !== null && !isIsoDate(value.lastSeenAt))
    || typeof value.current !== 'boolean'
    || (value.revokedAt !== null && !isIsoDate(value.revokedAt))) return invalidResponse();
  return {
    id: value.id,
    label: value.label,
    platform: value.platform,
    lastSeenAt: value.lastSeenAt,
    current: value.current,
    revokedAt: value.revokedAt
  };
};

const parseSyncHead = (value: unknown): SyncHead => {
  if (!isRecord(value)
    || !hasExactKeys(value, ['vaultId', 'revision', 'keyVersion', 'payloadHash', 'updatedAt'])
    || !isNonEmptyString(value.vaultId)
    || !isInteger(value.revision)
    || !isInteger(value.keyVersion)
    || !isNonEmptyString(value.payloadHash)
    || !isIsoDate(value.updatedAt)) return invalidResponse();
  return {
    vaultId: value.vaultId,
    revision: value.revision,
    keyVersion: value.keyVersion,
    payloadHash: value.payloadHash,
    updatedAt: value.updatedAt
  };
};

const parseWrappedKeyEnvelope = (value: unknown): boolean => isRecord(value)
  && hasExactKeys(value, ['version', 'nonce', 'ciphertext', 'authTag', 'aad'])
  && isInteger(value.version)
  && isNonEmptyString(value.nonce)
  && isNonEmptyString(value.ciphertext)
  && isNonEmptyString(value.authTag)
  && isNonEmptyString(value.aad);

const parseVaultUnlockEnvelope = (value: unknown): boolean => {
  const allowedKeys = new Set(['version', 'kdf', 'wrappedVaultKey', 'recoveryKeyVersion', 'recoveryWrappedVaultKey', 'pendingRecoveryKeyVersion', 'pendingRecoveryWrappedVaultKey']);
  if (!isRecord(value)
    || Object.keys(value).some((key) => !allowedKeys.has(key))
    || !Object.prototype.hasOwnProperty.call(value, 'version')
    || !Object.prototype.hasOwnProperty.call(value, 'kdf')
    || !Object.prototype.hasOwnProperty.call(value, 'wrappedVaultKey')
    || !isInteger(value.version)
    || !isRecord(value.kdf)
    || !hasExactKeys(value.kdf, ['algorithm', 'salt', 'memoryCost', 'timeCost', 'parallelism', 'hashLength'])
    || !isNonEmptyString(value.kdf.algorithm)
    || !isNonEmptyString(value.kdf.salt)
    || !isInteger(value.kdf.memoryCost)
    || !isInteger(value.kdf.timeCost)
    || !isInteger(value.kdf.parallelism)
    || !isInteger(value.kdf.hashLength)
    || !parseWrappedKeyEnvelope(value.wrappedVaultKey)) return false;
  const hasRecoveryWrapper = value.recoveryWrappedVaultKey !== undefined;
  const hasRecoveryVersion = value.recoveryKeyVersion !== undefined;
  const hasPendingWrapper = value.pendingRecoveryWrappedVaultKey !== undefined;
  const hasPendingVersion = value.pendingRecoveryKeyVersion !== undefined;
  if (hasRecoveryWrapper !== hasRecoveryVersion || hasPendingWrapper !== hasPendingVersion) return false;
  if (hasRecoveryVersion && (!isInteger(value.recoveryKeyVersion) || value.recoveryKeyVersion < 1 || value.recoveryKeyVersion > MAX_SYNC_KEY_VERSION)) return false;
  if (hasPendingVersion && (!isInteger(value.pendingRecoveryKeyVersion) || value.pendingRecoveryKeyVersion < 1 || value.pendingRecoveryKeyVersion > MAX_SYNC_KEY_VERSION)) return false;
  if (hasRecoveryVersion && hasPendingVersion && (value.pendingRecoveryKeyVersion as number) <= (value.recoveryKeyVersion as number)) return false;
  if (hasRecoveryWrapper && !parseWrappedKeyEnvelope(value.recoveryWrappedVaultKey)) return false;
  return !hasPendingWrapper || parseWrappedKeyEnvelope(value.pendingRecoveryWrappedVaultKey);
};

const parseSyncDescriptor = (value: unknown): SyncDescriptor => {
  if (!isRecord(value)
    || !hasExactKeys(value, ['vaultId', 'keyVersion', 'vaultUnlockEnvelope', 'wrappedSyncKey'])
    || !isNonEmptyString(value.vaultId)
    || !isInteger(value.keyVersion)
    || !parseVaultUnlockEnvelope(value.vaultUnlockEnvelope)
    || !parseWrappedKeyEnvelope(value.wrappedSyncKey)) return invalidResponse();
  return value as unknown as SyncDescriptor;
};

const syncStatuses: readonly SyncStatus[] = ['local-only', 'needs-unlock', 'syncing', 'synced', 'pending', 'offline', 'conflict', 'device-revoked'];

const isSyncStatus = (value: unknown): value is SyncStatus => typeof value === 'string' && syncStatuses.includes(value as SyncStatus);

const parseRecoveryKeyState = (value: unknown): RecoveryKeyState => {
  if (!isRecord(value)
    || !hasExactKeys(value, ['status', 'activeKeyVersion', 'pendingKeyVersion'])
    || !['not-configured', 'pending-confirmation', 'configured'].includes(value.status as string)
    || (value.activeKeyVersion !== null && (!isInteger(value.activeKeyVersion) || value.activeKeyVersion < 1))
    || (value.activeKeyVersion !== null && value.activeKeyVersion > MAX_SYNC_KEY_VERSION)
    || (value.pendingKeyVersion !== null && (!isInteger(value.pendingKeyVersion) || value.pendingKeyVersion < 1))
    || (value.pendingKeyVersion !== null && value.pendingKeyVersion > MAX_SYNC_KEY_VERSION)
    || (value.status === 'not-configured' && (value.activeKeyVersion !== null || value.pendingKeyVersion !== null))
    || (value.status === 'configured' && (value.activeKeyVersion === null || value.pendingKeyVersion !== null))
    || (value.status === 'pending-confirmation' && value.pendingKeyVersion === null)
    || (value.activeKeyVersion !== null && value.pendingKeyVersion !== null && value.pendingKeyVersion <= value.activeKeyVersion)) return invalidResponse();
  return {
    status: value.status as RecoveryKeyState['status'],
    activeKeyVersion: value.activeKeyVersion as number | null,
    pendingKeyVersion: value.pendingKeyVersion as number | null
  };
};

const parseSyncStateResponse = (value: unknown): WebSyncStateResponse => {
  if (!isRecord(value)
    || !hasExactKeys(value, ['sync', 'head', 'pendingCount', 'lastError', 'lastErrorCode', 'lastSyncedAt', 'recovery', 'deletion'].filter((key) => value[key] !== undefined))
    || !isSyncStatus(value.sync)
    || (value.head !== null && !isRecord(value.head))) return invalidResponse();
  const pendingCount = value.pendingCount === undefined ? undefined : isInteger(value.pendingCount) && value.pendingCount >= 0 ? value.pendingCount : invalidResponse();
  if (value.lastError !== undefined && typeof value.lastError !== 'string') return invalidResponse();
  if (value.lastErrorCode !== undefined && typeof value.lastErrorCode !== 'string') return invalidResponse();
  if (value.lastSyncedAt !== undefined && !isIsoDate(value.lastSyncedAt)) return invalidResponse();
  const recovery = value.recovery === undefined ? undefined : parseRecoveryKeyState(value.recovery);
  const head = value.head === null ? null : parseSyncHead(value.head);
  let deletion: SyncState['deletion'] | undefined;
  if (value.deletion !== undefined) {
    if (!isRecord(value.deletion)
      || !hasExactKeys(value.deletion, ['deleteAfter', 'requestedAt', 'remainingMs'])
      || !isIsoDate(value.deletion.deleteAfter)
      || !isIsoDate(value.deletion.requestedAt)
      || typeof value.deletion.remainingMs !== 'number'
      || !Number.isFinite(value.deletion.remainingMs)
      || value.deletion.remainingMs < 0) return invalidResponse();
    deletion = { deleteAfter: value.deletion.deleteAfter, requestedAt: value.deletion.requestedAt, remainingMs: value.deletion.remainingMs };
  }
  return {
    sync: value.sync,
    head,
    ...(pendingCount === undefined ? {} : { pendingCount }),
    ...(value.lastError === undefined ? {} : { lastError: value.lastError }),
    ...(value.lastErrorCode === undefined ? {} : { lastErrorCode: value.lastErrorCode }),
    ...(value.lastSyncedAt === undefined ? {} : { lastSyncedAt: value.lastSyncedAt }),
    ...(recovery === undefined ? {} : { recovery }),
    ...(deletion === undefined ? {} : { deletion })
  };
};

const parseRecoveryKeyIssue = (value: unknown): WebRecoveryKeyIssueResponse => {
  if (!isRecord(value)
    || !hasExactKeys(value, ['recoveryKey', 'keyVersion', 'status', 'recovery'])
    || !isNonEmptyString(value.recoveryKey)
    || value.recoveryKey.length > 128
    || !/^RLY-RK1(?:-[A-Z2-7]{4})+$/u.test(value.recoveryKey)
    || !isInteger(value.keyVersion)
    || value.keyVersion < 1
    || value.keyVersion > MAX_SYNC_KEY_VERSION
    || value.status !== 'pending-confirmation') return invalidResponse();
  return {
    recoveryKey: value.recoveryKey,
    keyVersion: value.keyVersion,
    status: 'pending-confirmation',
    recovery: parseRecoveryKeyState(value.recovery)
  };
};

const parseSyncPreview = (value: unknown): SyncPreview => {
  const conflictTypes: SyncPreview['conflictTypes'] = ['host', 'group', 'identity', 'snippet', 'workspace', 'host-key'];
  if (!isRecord(value)
    || !hasExactKeys(value, ['conflictId', 'localRevision', 'remoteRevision', 'conflictTypes', 'localBackupRevision'])
    || !isNonEmptyString(value.conflictId)
    || !isInteger(value.localRevision)
    || !isInteger(value.remoteRevision)
    || !Array.isArray(value.conflictTypes)
    || value.conflictTypes.some((type) => !conflictTypes.includes(type as SyncPreview['conflictTypes'][number]))
    || !isInteger(value.localBackupRevision)) return invalidResponse();
  return {
    conflictId: value.conflictId,
    localRevision: value.localRevision,
    remoteRevision: value.remoteRevision,
    conflictTypes: value.conflictTypes as SyncPreview['conflictTypes'],
    localBackupRevision: value.localBackupRevision
  };
};

const recoveryConflictTypes: readonly VaultRecoveryPreview['conflictTypes'][number][] = ['host', 'group', 'identity', 'snippet', 'workspace', 'host-key'];

const parseVaultRecoveryPreview = (value: unknown): VaultRecoveryPreview => {
  if (!isRecord(value)
    || !hasExactKeys(value, ['previewId', 'vaultId', 'revision', 'payloadHash', 'hostCount', 'groupCount', 'identityCount', 'snippetCount', 'workspaceIncluded', 'conflictTypes', 'expiresAt'])
    || !isNonEmptyString(value.previewId) || value.previewId.length > 128
    || !isNonEmptyString(value.vaultId) || value.vaultId.length > 128
    || !isInteger(value.revision)
    || value.revision < 1
    || typeof value.payloadHash !== 'string'
    || !/^[a-f0-9]{64}$/iu.test(value.payloadHash)
    || !isInteger(value.hostCount) || value.hostCount < 0 || value.hostCount > 10_000
    || !isInteger(value.groupCount) || value.groupCount < 0 || value.groupCount > 10_000
    || !isInteger(value.identityCount) || value.identityCount < 0 || value.identityCount > 10_000
    || !isInteger(value.snippetCount) || value.snippetCount < 0 || value.snippetCount > 10_000
    || typeof value.workspaceIncluded !== 'boolean'
    || !Array.isArray(value.conflictTypes) || value.conflictTypes.length > recoveryConflictTypes.length
    || value.conflictTypes.some((type) => !recoveryConflictTypes.includes(type as VaultRecoveryPreview['conflictTypes'][number]))
    || !isIsoDate(value.expiresAt)) return invalidResponse();
  return {
    previewId: value.previewId,
    vaultId: value.vaultId,
    revision: value.revision,
    payloadHash: value.payloadHash,
    hostCount: value.hostCount,
    groupCount: value.groupCount,
    identityCount: value.identityCount,
    snippetCount: value.snippetCount,
    workspaceIncluded: value.workspaceIncluded,
    conflictTypes: value.conflictTypes as VaultRecoveryPreview['conflictTypes'],
    expiresAt: value.expiresAt
  };
};

const parseSetupStatus = (value: unknown): SetupStatus => {
  if (!isRecord(value) || !hasExactKeys(value, ['initialized', 'locked']) || typeof value.initialized !== 'boolean' || typeof value.locked !== 'boolean') return invalidResponse();
  return { initialized: value.initialized, locked: value.locked };
};

const parseSyncDescriptorResponse = (value: unknown): SyncDescriptor | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['descriptor']) || (value.descriptor !== null && value.descriptor !== undefined && !isRecord(value.descriptor))) return invalidResponse();
  return value.descriptor === null || value.descriptor === undefined ? null : parseSyncDescriptor(value.descriptor);
};

const parseSyncEnvelope = (envelope: unknown): SyncEnvelope => {
  if (!isRecord(envelope)) return invalidResponse();
  if (!hasExactKeys(envelope, ['schemaVersion', 'vaultId', 'revision', 'parentRevision', 'deviceId', 'keyVersion', 'nonce', 'ciphertext', 'authTag', 'aad', 'payloadHash', 'byteLength'])
    || envelope.schemaVersion !== 1
    || !isNonEmptyString(envelope.vaultId)
    || !isInteger(envelope.revision)
    || (envelope.parentRevision !== null && !isInteger(envelope.parentRevision))
    || !isNonEmptyString(envelope.deviceId)
    || !isInteger(envelope.keyVersion)
    || !isNonEmptyString(envelope.nonce)
    || !isNonEmptyString(envelope.ciphertext)
    || !isNonEmptyString(envelope.authTag)
    || !isNonEmptyString(envelope.aad)
    || !/^[a-f0-9]{64}$/iu.test(typeof envelope.payloadHash === 'string' ? envelope.payloadHash : '')
    || !isInteger(envelope.byteLength)
    || envelope.byteLength < 0
    || envelope.byteLength > 32 * 1024 * 1024) return invalidResponse();
  return envelope as unknown as SyncEnvelope;
};

const parseSyncEnvelopeResponse = (value: unknown): SyncEnvelope | null => {
  if (!isRecord(value) || !hasExactKeys(value, ['envelope']) || (value.envelope !== null && value.envelope !== undefined && !isRecord(value.envelope))) return invalidResponse();
  if (value.envelope === null || value.envelope === undefined) return null;
  return parseSyncEnvelope(value.envelope);
};

const parseWebSyncConflictExport = (value: unknown): SyncConflictExport => {
  try {
    return parseSyncConflictExport(value);
  } catch (error) {
    if (error instanceof AppError && error.code === 'SYNC_PAYLOAD_INVALID') return invalidResponse();
    throw error;
  }
};

export const getSetupStatus = (): Promise<SetupStatus> => request<SetupStatus>('/api/setup/status');

export const getCapabilities = (): Promise<CapabilityResponse> => request<CapabilityResponse>('/api/capabilities');

export const getAccountSession: WebAccountApi['getAccountSession'] = () => request<unknown>('/api/account/session').then(parseAccountSessionResponse);

export const register: WebAccountApi['register'] = (email, password, deviceLabel) => request<unknown>('/api/account/register', {
  method: 'POST',
  ...json({ email, password, ...(deviceLabel === undefined ? {} : { deviceLabel }) })
}).then(parseAccountAuthResponse);

export const signIn: WebAccountApi['signIn'] = (email, password, deviceLabel) => request<unknown>('/api/account/session', {
  method: 'POST',
  ...json({ email, password, ...(deviceLabel === undefined ? {} : { deviceLabel }) })
}).then(parseAccountAuthResponse);

export const signOut: WebAccountApi['signOut'] = () => request<void>('/api/account/session', { method: 'DELETE' });

export const listDevices: WebAccountApi['listDevices'] = () => request<unknown>('/api/account/devices').then((value) => {
  if (!Array.isArray(value)) return invalidResponse();
  return value.map(parseDevice);
});

export const revokeDevice: WebAccountApi['revokeDevice'] = (deviceId) => request<void>(`/api/account/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });

export const getSyncState: WebSyncApi['getSyncState'] = () => request<unknown>('/api/sync/v1/state').then(parseSyncStateResponse);

export const getSyncDescriptor: WebSyncApi['getSyncDescriptor'] = () => request<unknown>('/api/sync/v1/descriptor').then(parseSyncDescriptorResponse);

export const enableSync: WebSyncApi['enableSync'] = () => request<unknown>('/api/sync/v1/enable', { method: 'POST' }).then(parseSyncHead);

export const issueRecoveryKey: WebSyncApi['issueRecoveryKey'] = () => request<unknown>('/api/sync/v1/recovery-key/issue', { method: 'POST' }).then(parseRecoveryKeyIssue);

export const confirmRecoveryKey: WebSyncApi['confirmRecoveryKey'] = (recoveryKey) => request<unknown>('/api/sync/v1/recovery-key/confirm', {
  method: 'POST',
  ...json({ recoveryKey })
}).then(parseRecoveryKeyState);

export const retrySync: WebSyncApi['retrySync'] = async () => {
  await request<unknown>('/api/sync/v1/retry', { method: 'POST' });
};

export const getSyncEnvelope = (): Promise<SyncEnvelope | null> => request<unknown>('/api/sync/v1/envelope').then(parseSyncEnvelopeResponse);

export const pushSyncEnvelope = (envelope: SyncEnvelope, idempotencyKey: string): Promise<SyncHead> => request<unknown>('/api/sync/v1/envelope', {
  method: 'PUT',
  headers: new Headers({ 'idempotency-key': idempotencyKey }),
  ...json(parseSyncEnvelope(envelope))
}).then(parseSyncHead);

export const previewPull: WebSyncApi['previewPull'] = () => request<unknown>('/api/sync/v1/pull/preview', { method: 'POST' }).then(parseSyncPreview);

export const resolveConflict: WebSyncApi['resolveConflict'] = (conflictId, resolution) => request<void>(`/api/sync/v1/conflicts/${encodeURIComponent(conflictId)}/resolve`, {
  method: 'POST',
  ...json({ resolution })
});

export const exportConflict: WebSyncApi['exportConflict'] = (conflictId, exportPassword) => request<unknown>(`/api/sync/v1/conflicts/${encodeURIComponent(conflictId)}/export`, {
  method: 'POST',
  ...json({ exportPassword })
}).then(parseWebSyncConflictExport);

export const previewSyncRecovery: WebVaultRecoveryApi['previewSyncRecovery'] = (input) => request<unknown>('/api/setup/from-sync/preview', {
  method: 'POST',
  ...json({ method: input.method, secret: input.secret })
}).then(parseVaultRecoveryPreview);

export const applySyncRecovery: WebVaultRecoveryApi['applySyncRecovery'] = (previewId, input) => request<unknown>('/api/setup/from-sync/apply', {
  method: 'POST',
  ...json({ previewId, method: input.method, secret: input.secret })
}).then(parseSetupStatus);

export const setupVault = (masterPassword: string): Promise<SetupStatus> => request<SetupStatus>('/api/setup', {
  method: 'POST',
  ...json({ masterPassword })
});

export const unlockVault = (masterPassword: string): Promise<SetupStatus> => request<SetupStatus>('/api/session/unlock', {
  method: 'POST',
  ...json({ masterPassword })
});

export const lockVault = (): Promise<void> => request<void>('/api/session/lock', { method: 'POST' });

export const listHosts = (filter: HostListFilter = {}): Promise<HostMetadata[]> => {
  const params = new URLSearchParams();
  if (filter.query) params.set('query', filter.query);
  if (filter.groupId) params.set('groupId', filter.groupId);
  if (filter.favorite !== undefined) params.set('favorite', String(filter.favorite));
  const suffix = params.toString();
  return request<HostMetadata[]>(`/api/hosts${suffix ? `?${suffix}` : ''}`);
};

export const getHost = (id: string): Promise<HostMetadata> => request<HostMetadata>(`/api/hosts/${encodeURIComponent(id)}`);

export const createHost = (input: HostCreateInput): Promise<HostMetadata> => request<HostMetadata>('/api/hosts', {
  method: 'POST',
  ...json(input)
});

export const updateHost = (id: string, input: HostPatchInput): Promise<HostMetadata> => request<HostMetadata>(`/api/hosts/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  ...json(input)
});

export const deleteHost = (id: string): Promise<void> => request<void>(`/api/hosts/${encodeURIComponent(id)}`, {
  method: 'DELETE'
});

export const clearHostKey = (id: string): Promise<void> => request<void>(`/api/hosts/${encodeURIComponent(id)}/host-key`, {
  method: 'DELETE'
});

export const listIdentities = (): Promise<IdentityMetadata[]> => request<IdentityMetadata[]>('/api/identities');

export const getIdentity = (id: string): Promise<IdentityMetadata> => request<IdentityMetadata>(`/api/identities/${encodeURIComponent(id)}`);

export const createIdentity = (input: IdentityCreateInput): Promise<IdentityMetadata> => request<IdentityMetadata>('/api/identities', {
  method: 'POST',
  ...json(input)
});

export const updateIdentity = (id: string, input: IdentityUpdateInput): Promise<IdentityMetadata> => request<IdentityMetadata>(`/api/identities/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  ...json(input)
});

export const deleteIdentity = (id: string): Promise<void> => request<void>(`/api/identities/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const listGroups = (): Promise<GroupSummaryResponse[]> => request<GroupSummaryResponse[]>('/api/groups');

export const getGroup = (id: string): Promise<GroupSummaryResponse> => request<GroupSummaryResponse>(`/api/groups/${encodeURIComponent(id)}`);

export const createGroup = (input: GroupMutationInput): Promise<GroupSummaryResponse> => request<GroupSummaryResponse>('/api/groups', {
  method: 'POST',
  ...json(input)
});

export const updateGroup = (id: string, input: GroupPatchInput): Promise<GroupSummaryResponse> => request<GroupSummaryResponse>(`/api/groups/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  ...json(input)
});

export const deleteGroup = (id: string): Promise<void> => request<void>(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const testConnection = (id: string): Promise<ConnectionTestResult> => request<ConnectionTestResult>(`/api/hosts/${encodeURIComponent(id)}/test-connection`, {
  method: 'POST',
  acceptedStatuses: [409]
});

export const getWorkspace = (): Promise<WorkspaceResponse> => request<WorkspaceResponse>('/api/workspace');

export const saveWorkspace = (expectedVersion: number, state: WorkspaceState): Promise<WorkspaceResponse> => request<WorkspaceResponse>('/api/workspace', {
  method: 'PUT',
  ...json({ expectedVersion, state })
});

export const listWorkspaceTemplates = (): Promise<WorkspaceTemplateResponse[]> => request<WorkspaceTemplateResponse[]>('/api/workspace/templates');

export const createWorkspaceTemplate = (input: { name: string; state: WorkspaceState }): Promise<WorkspaceTemplateResponse> => request<WorkspaceTemplateResponse>('/api/workspace/templates', {
  method: 'POST',
  ...json(input)
});

export const deleteWorkspaceTemplate = (id: string): Promise<void> => request<void>(`/api/workspace/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const exportVaultBundle = (exportPassword: string): Promise<{ bundle: string }> => request<{ bundle: string }>('/api/vault/export', {
  method: 'POST',
  ...json({ exportPassword })
});

export const previewVaultImport = (exportPassword: string, bundle: string): Promise<ImportPreviewResponse> => request<ImportPreviewResponse>('/api/vault/import/preview', {
  method: 'POST',
  ...json({ exportPassword, bundle })
});

export const applyVaultImport = (
  previewId: string,
  resolution: { hostConflicts: 'skip' | 'replace'; groupConflicts: 'reuse' | 'replace'; identityConflicts?: 'reuse' | 'replace' }
): Promise<ImportResultResponse> => request<ImportResultResponse>('/api/vault/import/apply', {
  method: 'POST',
  ...json({ previewId, resolution })
});

export const listImportFormats = (): Promise<Array<{ id: ImportFormat; label: string; extensions: string[]; description: string }>> => request('/api/import/formats');

export const previewExternalImport = (files: readonly File[], formatHint?: ImportFormat): Promise<ExternalImportPreviewResponse> => {
  const form = new FormData();
  for (const file of files) form.append('file', file, file.name);
  if (formatHint) form.append('format', formatHint);
  return request<ExternalImportPreviewResponse>('/api/import/preview', { method: 'POST', body: form });
};

export const applyExternalImport = (previewId: string, input: ImportApplyRequest): Promise<ExternalImportResultResponse> => request<ExternalImportResultResponse>('/api/import/apply', {
  method: 'POST',
  ...json({ previewId, ...input })
});

export const exportOpenSshConfig = (): Promise<Blob> => request<Blob>('/api/export/openssh', { responseType: 'blob' });

export const exportSshCsv = (options: ExportOptions = {}): Promise<Blob> => {
  const params = new URLSearchParams();
  if (options.includePasswords) params.set('includePasswords', 'true');
  if (options.confirmPasswordExport) params.set('confirmPasswordExport', 'true');
  const suffix = params.toString();
  return request<Blob>(`/api/export/csv${suffix ? `?${suffix}` : ''}`, { responseType: 'blob' });
};

export const listSnippets = (): Promise<SnippetMetadata[]> => request<SnippetMetadata[]>('/api/snippets');

export const getSnippet = (id: string): Promise<SnippetResponse> => request<SnippetResponse>(`/api/snippets/${encodeURIComponent(id)}`);

export const createSnippet = (input: Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>): Promise<SnippetResponse> => request<SnippetResponse>('/api/snippets', {
  method: 'POST',
  ...json(input)
});

export const updateSnippet = (id: string, input: Partial<Omit<Snippet, 'id' | 'createdAt' | 'updatedAt'>>): Promise<SnippetResponse> => request<SnippetResponse>(`/api/snippets/${encodeURIComponent(id)}`, {
  method: 'PATCH',
  ...json(input)
});

export const deleteSnippet = (id: string): Promise<void> => request<void>(`/api/snippets/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const startCommandRun = (input: CommandRunRequest): Promise<CommandRunResponse> => request<CommandRunResponse>('/api/command-runs', {
  method: 'POST',
  ...json(input)
});

export const getCommandRun = (id: string): Promise<CommandRunResponse> => request<CommandRunResponse>(`/api/command-runs/${encodeURIComponent(id)}`);

export const cancelCommandRun = (id: string): Promise<void> => request<void>(`/api/command-runs/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const listSftpEntries = (hostId: string, path = '/'): Promise<SftpEntry[]> => request<SftpEntry[]>(`/api/sftp/${encodeURIComponent(hostId)}/list?path=${encodeURIComponent(path)}`);

export const mutateSftpEntry = (hostId: string, input: { action: 'mkdir'; path: string } | { action: 'rename'; from: string; to: string } | { action: 'delete'; path: string; confirmed: boolean }): Promise<void> => request<void>(`/api/sftp/${encodeURIComponent(hostId)}/entries`, {
  method: 'POST',
  ...json(input)
});

export const createTransfer = (input: { kind: 'upload' | 'download'; hostId: string; sourcePath: string; targetPath: string; totalBytes?: number | null }): Promise<TransferJob> => request<TransferJob>('/api/sftp/' + encodeURIComponent(input.hostId) + '/transfers', {
  method: 'POST',
  ...json(input)
});

export const listTransfers = (): Promise<TransferJob[]> => request<TransferJob[]>('/api/transfers');

export const getTransfer = (id: string): Promise<TransferJob> => request<TransferJob>(`/api/transfers/${encodeURIComponent(id)}`);

export const uploadTransferContent = (id: string, source: ReadableStream<Uint8Array>, resume?: TransferResumeRequest): Promise<TransferJob> => request<TransferJob>(`/api/transfers/${encodeURIComponent(id)}/content`, {
  method: 'PUT',
  headers: new Headers({
    'content-type': 'application/octet-stream',
    ...(resume === undefined ? {} : {
      'x-transfer-offset': String(resume.expectedOffset),
      ...(resume.checksum === null ? {} : { 'x-transfer-checksum': resume.checksum })
    })
  }),
  body: source,
  timeoutMs: null,
  duplex: 'half'
});

export const uploadTransferChunk = (id: string, chunk: Blob, resume: TransferResumeRequest, nextChecksum: string, final: boolean): Promise<TransferJob> => request<TransferJob>(`/api/transfers/${encodeURIComponent(id)}/content/chunk`, {
  method: 'PUT',
  headers: new Headers({
    'content-type': 'application/octet-stream',
    'x-transfer-offset': String(resume.expectedOffset),
    ...(resume.checksum === null ? {} : { 'x-transfer-checksum': resume.checksum }),
    'x-transfer-next-checksum': nextChecksum,
    'x-transfer-final': String(final)
  }),
  body: chunk,
  timeoutMs: null
});

export const downloadTransferContent = (id: string, resume?: TransferResumeRequest): Promise<ReadableStream<Uint8Array>> => request<ReadableStream<Uint8Array>>(`/api/transfers/${encodeURIComponent(id)}/content`, {
  headers: resume === undefined ? undefined : new Headers({
    'x-transfer-offset': String(resume.expectedOffset),
    ...(resume.checksum === null ? {} : { 'x-transfer-checksum': resume.checksum })
  }),
  responseType: 'stream',
  timeoutMs: null
});

export const cancelTransfer = (id: string): Promise<void> => request<void>(`/api/transfers/${encodeURIComponent(id)}`, { method: 'DELETE' });

export const pauseTransfer = (id: string): Promise<void> => request<void>(`/api/transfers/${encodeURIComponent(id)}/pause`, { method: 'POST' });

export const retryTransfer = (id: string): Promise<TransferJob> => request<TransferJob>(`/api/transfers/${encodeURIComponent(id)}/retry`, { method: 'POST' });

export const listAuditEvents = (filter: ActivityFilter = {}): Promise<AuditEventsResponse> => {
  const params = new URLSearchParams();
  if (filter.cursor) params.set('cursor', filter.cursor);
  if (filter.limit !== undefined) params.set('limit', String(filter.limit));
  if (filter.eventType) params.set('eventType', filter.eventType);
  if (filter.hostId) params.set('hostId', filter.hostId);
  if (filter.requestId) params.set('requestId', filter.requestId);
  if (filter.status) params.set('status', filter.status);
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  const suffix = params.toString();
  return request<AuditEventsResponse>(`/api/audit${suffix ? `?${suffix}` : ''}`);
};
