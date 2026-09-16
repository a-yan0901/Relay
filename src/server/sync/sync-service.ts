import { randomUUID, timingSafeEqual } from 'node:crypto';

import type { FastifyRequest } from 'fastify';

import type {
  SyncDescriptor,
  SyncConflictExport,
  SyncEnvelope,
  SyncHead,
  SyncPreview,
  RecoveryKeyState,
  VaultRecoveryPreview,
  SyncResolution,
  SyncState,
  SyncStatus,
  VaultUnlockEnvelope
} from '../../shared/core/models.js';
import { AppError } from '../../shared/errors.js';
import { getAccountSessionId } from '../auth/account-cookie.js';
import { getSessionId } from '../auth/session-cookie.js';
import { AccountService } from '../account/account-service.js';
import { AppConfigRepository } from '../db/repositories.js';
import { SessionStore } from '../auth/session-store.js';
import {
  createRecoveryKey,
  createSyncKey,
  decryptSyncPayload,
  encryptSyncPayload,
  formatRecoveryKey,
  parseRecoveryKey,
  RECOVERY_KEY_VERSION,
  unwrapSyncKey,
  unwrapVaultKeyWithRecoveryKey,
  wrapSyncKey,
  wrapVaultKeyWithRecoveryKey
} from './sync-crypto.js';
import { BlindSyncRepository, type BlindSyncStore, type SyncClientState, type SyncDeleteRequest } from './sync-repository.js';
import { SyncSnapshotService } from './sync-snapshot.js';
import {
  assembleSyncConflictExport,
  assertSyncConflictExportPassword,
  createSyncConflictExportCopy
} from './sync-conflict-export.js';
import type { VaultConfig } from '../vault/types.js';

export interface SyncServiceContract {
  status(accountId: string): SyncState;
  getDescriptor(accountId: string): SyncDescriptor | null;
  getRecoveryKeyState(accountId: string): RecoveryKeyState;
  getEnvelope(accountId: string): SyncEnvelope | null;
  enable(accountId: string, ownerId: string, deviceId: string, vaultKey: Buffer, vaultConfig: VaultConfig): Promise<SyncHead>;
  issueRecoveryKey(accountId: string, vaultKey: Buffer): RecoveryKeyIssue;
  confirmRecoveryKey(accountId: string, vaultKey: Buffer, recoveryKey: string): RecoveryKeyState;
  prepareEnvelope(accountId: string, ownerId: string, deviceId: string, vaultKey: Buffer): Promise<SyncEnvelope>;
  pull(accountId: string): SyncEnvelope | null;
  push(accountId: string, envelope: SyncEnvelope, idempotencyKey: string): SyncHead;
  previewPull(accountId: string, ownerId: string, vaultKey: Buffer): Promise<SyncPreview>;
  previewRecovery(accountId: string, deviceId: string, ownerId: string, vaultKey: Buffer): Promise<VaultRecoveryPreview>;
  applyRecovery(accountId: string, deviceId: string, ownerId: string, vaultKey: Buffer, previewId: string, afterApply?: () => void): Promise<void>;
  exportConflict(accountId: string, ownerId: string, vaultKey: Buffer, conflictId: string, exportPassword: string): Promise<SyncConflictExport>;
  resolveConflict(accountId: string, ownerId: string, vaultKey: Buffer, conflictId: string, resolution: SyncResolution): Promise<void>;
  getClientState(accountId: string): SyncClientState | null;
  savePending(accountId: string, envelope: SyncEnvelope | null, status: Extract<SyncStatus, 'pending' | 'offline' | 'conflict' | 'needs-unlock' | 'device-revoked'>, errorCode?: string | null): void;
  markSynced(accountId: string): void;
  requestDeletion(accountId: string): SyncDeleteRequest;
  getDeleteRequest(accountId: string): SyncDeleteRequest | null;
  restoreDeletion(accountId: string): void;
}

export interface SyncServiceOptions {
  store: BlindSyncStore;
  snapshotService: SyncSnapshotService;
  now?: () => number;
}

export interface SyncMutationContext {
  accountId: string;
  deviceId: string;
  ownerId: string;
  vaultSessionId: string;
  vaultKey: Buffer;
  requestId: string;
}

export interface SyncTransport {
  push(accountId: string, envelope: SyncEnvelope, idempotencyKey: string): Promise<SyncHead> | SyncHead;
}

export interface SyncCoordinatorOptions {
  syncService: SyncServiceContract;
  accountService: AccountService;
  sessionStore: SessionStore;
  appConfigRepository: AppConfigRepository;
  transport?: SyncTransport;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}

export interface SyncCoordinatorPort {
  markDirtyFromRequest(request: FastifyRequest, ownerId: string): void;
  markDirty(context: SyncMutationContext): void;
  retry(accountId: string): Promise<void>;
  flush(accountId: string): Promise<void>;
  cancelAccount(accountId: string): void;
  cancelAll(): void;
  close(): void;
}

const SYNC_DELETE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const MAX_RETRY_ATTEMPTS = 8;
const MAX_RECOVERY_KEY_VERSION = 32;
const RECOVERY_PREVIEW_TTL_MS = 10 * 60 * 1000;
const MAX_RECOVERY_PREVIEWS = 64;

interface RecoveryKeyIssue {
  recoveryKey: string;
  keyVersion: number;
  status: 'pending-confirmation';
}

interface PendingRecoveryPreview {
  accountId: string;
  deviceId: string;
  ownerId: string;
  vaultId: string;
  revision: number;
  keyVersion: number;
  payloadHash: string;
  expiresAt: number;
}

const toVaultUnlockEnvelope = (vaultConfig: VaultConfig): VaultUnlockEnvelope => ({
  version: vaultConfig.version,
  kdf: { ...vaultConfig.kdf },
  wrappedVaultKey: vaultConfig.wrappedVaultKey
});

const recoveryKeyStateFromDescriptor = (descriptor: SyncDescriptor | null): RecoveryKeyState => {
  const envelope = descriptor?.vaultUnlockEnvelope;
  const activeKeyVersion = envelope?.recoveryWrappedVaultKey
    ? envelope.recoveryKeyVersion ?? RECOVERY_KEY_VERSION
    : null;
  const pendingKeyVersion = envelope?.pendingRecoveryWrappedVaultKey
    ? envelope.pendingRecoveryKeyVersion ?? null
    : null;
  return {
    status: pendingKeyVersion !== null ? 'pending-confirmation' : activeKeyVersion !== null ? 'configured' : 'not-configured',
    activeKeyVersion,
    pendingKeyVersion
  };
};

export const syncEnvelopeIdempotencyKey = (accountId: string, envelope: SyncEnvelope): string => (
  `sync:${accountId}:${envelope.revision}:${envelope.payloadHash}`
);

const errorCodeOf = (error: unknown): string => (
  error instanceof AppError ? error.code : 'SYNC_PROVIDER_UNAVAILABLE'
);

const isPermanentFailure = (error: unknown): boolean => error instanceof AppError && [
  'SYNC_CONFLICT',
  'SYNC_PAYLOAD_INVALID',
  'SYNC_KEY_VERSION_UNSUPPORTED',
  'ACCOUNT_DEVICE_REVOKED',
  'SYNC_NOT_ENABLED',
  'SYNC_NOT_FOUND'
].includes(error.code);

export class SyncService implements SyncServiceContract {
  private readonly store: BlindSyncStore;
  private readonly snapshotService: SyncSnapshotService;
  private readonly clock: () => number;
  private readonly recoveryPreviews = new Map<string, PendingRecoveryPreview>();
  private readonly applyingRecoveryPreviews = new Set<string>();

  constructor(options: SyncServiceOptions) {
    this.store = options.store;
    this.snapshotService = options.snapshotService;
    this.clock = options.now ?? Date.now;
  }

  status(accountId: string): SyncState {
    this.store.purgeExpiredVault(accountId, new Date(this.clock()).toISOString());
    const descriptor = this.store.getDescriptor(accountId);
    if (!descriptor) return { sync: 'local-only', head: null, pendingCount: 0 };

    const head = this.store.getHead(accountId);
    const clientState = this.store.getClientState(accountId);
    const persistedStatus = clientState?.status === 'syncing' ? 'pending' : clientState?.status;
    const pendingCount = clientState?.pendingEnvelope ? 1 : 0;
    let sync: SyncStatus;
    if (persistedStatus && persistedStatus !== 'synced' && persistedStatus !== 'local-only') {
      sync = persistedStatus;
    } else if (head) {
      sync = 'synced';
    } else {
      sync = 'pending';
    }

    const deletion = this.store.getDeleteRequest(accountId);
    const state: SyncState = {
      sync,
      head,
      pendingCount,
      recovery: recoveryKeyStateFromDescriptor(descriptor),
      ...(clientState?.errorCode === null || clientState?.errorCode === undefined ? {} : { lastErrorCode: clientState.errorCode }),
      ...(head ? { lastSyncedAt: head.updatedAt } : {}),
      ...(deletion ? {
        deletion: {
          ...deletion,
          remainingMs: Math.max(0, Date.parse(deletion.deleteAfter) - this.clock())
        }
      } : {})
    };
    return state;
  }

  getDescriptor(accountId: string): SyncDescriptor | null {
    this.store.purgeExpiredVault(accountId, new Date(this.clock()).toISOString());
    return this.store.getDescriptor(accountId);
  }

  getRecoveryKeyState(accountId: string): RecoveryKeyState {
    return recoveryKeyStateFromDescriptor(this.getDescriptor(accountId));
  }

  getEnvelope(accountId: string): SyncEnvelope | null {
    this.store.purgeExpiredVault(accountId, new Date(this.clock()).toISOString());
    return this.store.getEnvelope(accountId);
  }

  async enable(
    accountId: string,
    ownerId: string,
    deviceId: string,
    vaultKey: Buffer,
    vaultConfig: VaultConfig
  ): Promise<SyncHead> {
    let descriptor = this.store.getDescriptor(accountId);
    let syncKey: Buffer;
    if (descriptor) {
      syncKey = unwrapSyncKey(vaultKey, descriptor.vaultId, descriptor.keyVersion, descriptor.wrappedSyncKey);
      const current = this.store.getHead(accountId);
      if (current) {
        syncKey.fill(0);
        this.store.clearClientState(accountId);
        return current;
      }
    } else {
      const vaultId = randomUUID();
      syncKey = createSyncKey();
      descriptor = {
        vaultId,
        keyVersion: 1,
        vaultUnlockEnvelope: toVaultUnlockEnvelope(vaultConfig),
        wrappedSyncKey: wrapSyncKey(vaultKey, vaultId, 1, syncKey)
      } satisfies SyncDescriptor;
    }

    let plaintext: Buffer | undefined;
    try {
      plaintext = await this.snapshotService.create(ownerId, vaultKey);
      const envelope = encryptSyncPayload({
        syncKey,
        vaultId: descriptor.vaultId,
        revision: 1,
        parentRevision: null,
        deviceId,
        keyVersion: descriptor.keyVersion,
        plaintext
      });
      this.store.saveDescriptor(accountId, descriptor);
      const head = this.store.putEnvelope(accountId, envelope, `enable:${accountId}:${descriptor.vaultId}`);
      this.store.clearClientState(accountId);
      return head;
    } finally {
      plaintext?.fill(0);
      syncKey.fill(0);
    }
  }

  issueRecoveryKey(accountId: string, vaultKey: Buffer): RecoveryKeyIssue {
    const descriptor = this.getDescriptor(accountId);
    if (!descriptor) throw new AppError('SYNC_NOT_ENABLED');
    const currentVersion = descriptor.vaultUnlockEnvelope.recoveryKeyVersion
      ?? (descriptor.vaultUnlockEnvelope.recoveryWrappedVaultKey ? RECOVERY_KEY_VERSION : 0);
    const pendingVersion = descriptor.vaultUnlockEnvelope.pendingRecoveryKeyVersion ?? 0;
    const keyVersion = Math.max(currentVersion, pendingVersion) + 1;
    if (keyVersion > MAX_RECOVERY_KEY_VERSION) throw new AppError('SYNC_KEY_VERSION_UNSUPPORTED');

    const recoveryKey = createRecoveryKey();
    try {
      const pendingRecoveryWrappedVaultKey = wrapVaultKeyWithRecoveryKey(
        vaultKey,
        descriptor.vaultId,
        keyVersion,
        recoveryKey
      );
      const vaultUnlockEnvelope = {
        ...descriptor.vaultUnlockEnvelope,
        pendingRecoveryKeyVersion: keyVersion,
        pendingRecoveryWrappedVaultKey
      };
      this.store.saveDescriptor(accountId, { ...descriptor, vaultUnlockEnvelope });
      return {
        recoveryKey: formatRecoveryKey(recoveryKey),
        keyVersion,
        status: 'pending-confirmation'
      };
    } finally {
      recoveryKey.fill(0);
    }
  }

  confirmRecoveryKey(accountId: string, vaultKey: Buffer, recoveryKeyValue: string): RecoveryKeyState {
    const descriptor = this.getDescriptor(accountId);
    if (!descriptor) throw new AppError('SYNC_NOT_ENABLED');
    const pendingWrapped = descriptor.vaultUnlockEnvelope.pendingRecoveryWrappedVaultKey;
    const pendingVersion = descriptor.vaultUnlockEnvelope.pendingRecoveryKeyVersion;
    if (!pendingWrapped || pendingVersion === undefined) throw new AppError('SYNC_RECOVERY_KEY_NOT_READY');

    let recoveryKey: Buffer | undefined;
    let recoveredVaultKey: Buffer | undefined;
    try {
      recoveryKey = parseRecoveryKey(recoveryKeyValue);
      recoveredVaultKey = unwrapVaultKeyWithRecoveryKey(recoveryKey, descriptor.vaultId, pendingVersion, pendingWrapped);
      if (recoveredVaultKey.length !== vaultKey.length || !timingSafeEqual(recoveredVaultKey, vaultKey)) {
        throw new AppError('VAULT_UNLOCK_FAILED');
      }

      const vaultUnlockEnvelope = { ...descriptor.vaultUnlockEnvelope };
      delete vaultUnlockEnvelope.pendingRecoveryKeyVersion;
      delete vaultUnlockEnvelope.pendingRecoveryWrappedVaultKey;
      vaultUnlockEnvelope.recoveryKeyVersion = pendingVersion;
      vaultUnlockEnvelope.recoveryWrappedVaultKey = pendingWrapped;
      this.store.saveDescriptor(accountId, { ...descriptor, vaultUnlockEnvelope });
      return recoveryKeyStateFromDescriptor({ ...descriptor, vaultUnlockEnvelope });
    } finally {
      recoveredVaultKey?.fill(0);
      recoveryKey?.fill(0);
    }
  }

  async prepareEnvelope(accountId: string, ownerId: string, deviceId: string, vaultKey: Buffer): Promise<SyncEnvelope> {
    const descriptor = this.store.getDescriptor(accountId);
    if (!descriptor) throw new AppError('SYNC_NOT_ENABLED');
    const current = this.store.getHead(accountId);
    const syncKey = unwrapSyncKey(vaultKey, descriptor.vaultId, descriptor.keyVersion, descriptor.wrappedSyncKey);
    let plaintext: Buffer | undefined;
    try {
      plaintext = await this.snapshotService.create(ownerId, vaultKey);
      return encryptSyncPayload({
        syncKey,
        vaultId: descriptor.vaultId,
        revision: (current?.revision ?? 0) + 1,
        parentRevision: current?.revision ?? null,
        deviceId,
        keyVersion: descriptor.keyVersion,
        plaintext
      });
    } finally {
      plaintext?.fill(0);
      syncKey.fill(0);
    }
  }

  pull(accountId: string): SyncEnvelope | null {
    return this.getEnvelope(accountId);
  }

  push(accountId: string, envelope: SyncEnvelope, idempotencyKey: string): SyncHead {
    const head = this.store.putEnvelope(accountId, envelope, idempotencyKey);
    this.store.clearClientState(accountId);
    return head;
  }

  async previewPull(accountId: string, ownerId: string, vaultKey: Buffer): Promise<SyncPreview> {
    const descriptor = this.getDescriptor(accountId);
    if (!descriptor) throw new AppError('SYNC_NOT_ENABLED');
    const remote = this.getEnvelope(accountId);
    if (!remote) throw new AppError('SYNC_NOT_FOUND');
    const syncKey = unwrapSyncKey(vaultKey, descriptor.vaultId, descriptor.keyVersion, descriptor.wrappedSyncKey);
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptSyncPayload(syncKey, remote);
      const preview = await this.snapshotService.previewApply(ownerId, vaultKey, plaintext);
      const pending = this.store.getClientState(accountId)?.pendingEnvelope;
      if (pending && pending.payloadHash !== remote.payloadHash && pending.parentRevision !== remote.revision) {
        const conflictId = this.store.saveConflict(accountId, pending, remote);
        this.savePending(accountId, pending, 'conflict', 'SYNC_CONFLICT');
        return {
          ...preview,
          conflictId,
          localRevision: pending.revision,
          remoteRevision: remote.revision,
          localBackupRevision: pending.revision
        };
      }
      return {
        ...preview,
        localRevision: remote.parentRevision ?? 0,
        remoteRevision: remote.revision,
        localBackupRevision: remote.parentRevision ?? 0
      };
    } finally {
      plaintext?.fill(0);
      syncKey.fill(0);
    }
  }

  async previewRecovery(accountId: string, deviceId: string, ownerId: string, vaultKey: Buffer): Promise<VaultRecoveryPreview> {
    this.pruneRecoveryPreviews();
    const descriptor = this.getDescriptor(accountId);
    if (!descriptor) throw new AppError('SYNC_NOT_ENABLED');
    const remote = this.getEnvelope(accountId);
    if (!remote) throw new AppError('SYNC_NOT_FOUND');
    if (remote.vaultId !== descriptor.vaultId) throw new AppError('SYNC_PAYLOAD_INVALID');
    const syncKey = unwrapSyncKey(vaultKey, descriptor.vaultId, descriptor.keyVersion, descriptor.wrappedSyncKey);
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptSyncPayload(syncKey, remote);
      const preview = await this.snapshotService.previewApply(ownerId, vaultKey, plaintext);
      const summary = this.snapshotService.describe(plaintext);
      const previewId = randomUUID();
      const expiresAt = this.clock() + RECOVERY_PREVIEW_TTL_MS;
      this.recoveryPreviews.set(previewId, {
        accountId,
        deviceId,
        ownerId,
        vaultId: remote.vaultId,
        revision: remote.revision,
        keyVersion: remote.keyVersion,
        payloadHash: remote.payloadHash,
        expiresAt
      });
      this.pruneRecoveryPreviews();
      return {
        previewId,
        vaultId: remote.vaultId,
        revision: remote.revision,
        payloadHash: remote.payloadHash,
        ...summary,
        conflictTypes: preview.conflictTypes,
        expiresAt: new Date(expiresAt).toISOString()
      };
    } finally {
      plaintext?.fill(0);
      syncKey.fill(0);
    }
  }

  async applyRecovery(
    accountId: string,
    deviceId: string,
    ownerId: string,
    vaultKey: Buffer,
    previewId: string,
    afterApply?: () => void
  ): Promise<void> {
    this.pruneRecoveryPreviews();
    const pending = this.recoveryPreviews.get(previewId);
    if (!pending || pending.accountId !== accountId || pending.deviceId !== deviceId || pending.ownerId !== ownerId) {
      throw new AppError('SYNC_NOT_FOUND');
    }
    if (this.applyingRecoveryPreviews.has(previewId)) throw new AppError('SYNC_CONFLICT');
    this.applyingRecoveryPreviews.add(previewId);

    try {
      const descriptor = this.getDescriptor(accountId);
      const remote = this.getEnvelope(accountId);
      if (!descriptor || !remote) {
        this.recoveryPreviews.delete(previewId);
        throw new AppError('SYNC_NOT_FOUND');
      }
      if (
        remote.vaultId !== pending.vaultId ||
        remote.revision !== pending.revision ||
        remote.keyVersion !== pending.keyVersion ||
        remote.payloadHash !== pending.payloadHash ||
        descriptor.vaultId !== pending.vaultId
      ) {
        this.recoveryPreviews.delete(previewId);
        throw new AppError('SYNC_CONFLICT');
      }

      const syncKey = unwrapSyncKey(vaultKey, descriptor.vaultId, descriptor.keyVersion, descriptor.wrappedSyncKey);
      let plaintext: Buffer | undefined;
      try {
        plaintext = decryptSyncPayload(syncKey, remote);
        await this.snapshotService.apply(ownerId, vaultKey, plaintext, 'use-remote', afterApply);
        this.recoveryPreviews.delete(previewId);
      } finally {
        plaintext?.fill(0);
        syncKey.fill(0);
      }
    } finally {
      this.applyingRecoveryPreviews.delete(previewId);
    }
  }

  async exportConflict(
    accountId: string,
    ownerId: string,
    vaultKey: Buffer,
    conflictId: string,
    exportPassword: string
  ): Promise<SyncConflictExport> {
    assertSyncConflictExportPassword(exportPassword);
    const conflict = this.store.getConflict(accountId, conflictId);
    if (!conflict) throw new AppError('SYNC_NOT_FOUND');
    const descriptor = this.getDescriptor(accountId);
    if (!descriptor) throw new AppError('SYNC_NOT_ENABLED');
    if (
      conflict.local.vaultId !== descriptor.vaultId ||
      conflict.remote.vaultId !== descriptor.vaultId ||
      conflict.local.keyVersion !== descriptor.keyVersion ||
      conflict.remote.keyVersion !== descriptor.keyVersion
    ) throw new AppError('SYNC_PAYLOAD_INVALID');

    let syncKey: Buffer | undefined;
    let localPlaintext: Buffer | undefined;
    let remotePlaintext: Buffer | undefined;
    try {
      syncKey = unwrapSyncKey(vaultKey, descriptor.vaultId, descriptor.keyVersion, descriptor.wrappedSyncKey);
      localPlaintext = decryptSyncPayload(syncKey, conflict.local);
      this.snapshotService.validate(localPlaintext);
      const local = await createSyncConflictExportCopy({
        conflictId,
        copy: 'local',
        revision: conflict.local.revision,
        payloadHash: conflict.local.payloadHash,
        plaintext: localPlaintext,
        exportPassword
      });
      localPlaintext.fill(0);
      localPlaintext = undefined;

      remotePlaintext = decryptSyncPayload(syncKey, conflict.remote);
      this.snapshotService.validate(remotePlaintext);
      const remote = await createSyncConflictExportCopy({
        conflictId,
        copy: 'remote',
        revision: conflict.remote.revision,
        payloadHash: conflict.remote.payloadHash,
        plaintext: remotePlaintext,
        exportPassword
      });

      const current = this.store.getConflict(accountId, conflictId);
      if (!current || JSON.stringify(current.local) !== JSON.stringify(conflict.local) || JSON.stringify(current.remote) !== JSON.stringify(conflict.remote)) {
        throw new AppError('SYNC_CONFLICT');
      }
      return assembleSyncConflictExport({
        conflictId,
        createdAt: new Date(this.clock()).toISOString(),
        local,
        remote
      });
    } catch (error) {
      if (error instanceof AppError && error.code === 'VAULT_CRYPTO_FAILED') throw new AppError('SYNC_PAYLOAD_INVALID');
      throw error;
    } finally {
      localPlaintext?.fill(0);
      remotePlaintext?.fill(0);
      syncKey?.fill(0);
    }
  }

  async resolveConflict(
    accountId: string,
    ownerId: string,
    vaultKey: Buffer,
    conflictId: string,
    resolution: SyncResolution
  ): Promise<void> {
    const conflict = this.store.getConflict(accountId, conflictId);
    if (!conflict) throw new AppError('SYNC_NOT_FOUND');
    if (resolution === 'export-both') throw new AppError('SYNC_CONFLICT', '请先导出本地和远端副本');
    if (resolution === 'keep-local') {
      this.savePending(accountId, conflict.local, 'pending');
      this.store.resolveConflict(accountId, conflictId);
      return;
    }
    const descriptor = this.getDescriptor(accountId);
    if (!descriptor) throw new AppError('SYNC_NOT_ENABLED');
    const syncKey = unwrapSyncKey(vaultKey, descriptor.vaultId, descriptor.keyVersion, descriptor.wrappedSyncKey);
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptSyncPayload(syncKey, conflict.remote);
      await this.snapshotService.apply(ownerId, vaultKey, plaintext, 'use-remote');
      this.store.resolveConflict(accountId, conflictId);
      this.store.clearClientState(accountId);
    } finally {
      plaintext?.fill(0);
      syncKey.fill(0);
    }
  }

  getClientState(accountId: string): SyncClientState | null {
    return this.store.getClientState(accountId);
  }

  savePending(
    accountId: string,
    envelope: SyncEnvelope | null,
    status: Extract<SyncStatus, 'pending' | 'offline' | 'conflict' | 'needs-unlock' | 'device-revoked'>,
    errorCode: string | null = null
  ): void {
    this.store.saveClientState(accountId, {
      pendingEnvelope: envelope,
      status,
      errorCode,
      updatedAt: new Date(this.clock()).toISOString()
    });
  }

  markSynced(accountId: string): void {
    this.store.clearClientState(accountId);
  }

  requestDeletion(accountId: string): SyncDeleteRequest {
    if (!this.getDescriptor(accountId)) throw new AppError('SYNC_NOT_ENABLED');
    const existing = this.store.getDeleteRequest(accountId);
    if (existing) return existing;
    const deleteAfter = new Date(this.clock() + SYNC_DELETE_GRACE_MS).toISOString();
    this.store.deleteAccountVault(accountId, deleteAfter);
    const request = this.store.getDeleteRequest(accountId);
    if (!request) throw new AppError('INTERNAL_ERROR');
    return request;
  }

  getDeleteRequest(accountId: string): SyncDeleteRequest | null {
    return this.store.getDeleteRequest(accountId);
  }

  restoreDeletion(accountId: string): void {
    this.store.restoreDeleteRequest(accountId);
  }

  private pruneRecoveryPreviews(): void {
    const now = this.clock();
    for (const [id, preview] of this.recoveryPreviews) {
      if (preview.expiresAt <= now) this.recoveryPreviews.delete(id);
    }
    while (this.recoveryPreviews.size > MAX_RECOVERY_PREVIEWS) {
      const first = this.recoveryPreviews.keys().next().value;
      if (typeof first !== 'string') return;
      this.recoveryPreviews.delete(first);
    }
  }
}

export class SyncCoordinator implements SyncCoordinatorPort {
  private readonly syncService: SyncServiceContract;
  private readonly accountService: AccountService;
  private readonly sessionStore: SessionStore;
  private readonly appConfigRepository: AppConfigRepository;
  private readonly transport: SyncTransport;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryAttempts = new Map<string, number>();
  private readonly requestIds = new Map<string, Set<string>>();
  private readonly generations = new Map<string, number>();
  private readonly dirtyAccounts = new Set<string>();
  private stopped = false;

  constructor(options: SyncCoordinatorOptions) {
    this.syncService = options.syncService;
    this.accountService = options.accountService;
    this.sessionStore = options.sessionStore;
    this.appConfigRepository = options.appConfigRepository;
    this.transport = options.transport ?? { push: (accountId, envelope, idempotencyKey) => this.syncService.push(accountId, envelope, idempotencyKey) };
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs = options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    if (!Number.isSafeInteger(this.retryBaseDelayMs) || this.retryBaseDelayMs < 1 || !Number.isSafeInteger(this.retryMaxDelayMs) || this.retryMaxDelayMs < this.retryBaseDelayMs) {
      throw new AppError('SYNC_PAYLOAD_INVALID');
    }
  }

  markDirtyFromRequest(request: FastifyRequest, ownerId: string): void {
    const accountSessionId = getAccountSessionId(request);
    if (!accountSessionId) return;
    const account = this.accountService.status(accountSessionId);
    if (!account) return;
    const vaultSessionId = getSessionId(request);
    if (!vaultSessionId) return;
    const vaultSession = this.sessionStore.get(vaultSessionId);
    const appConfig = this.appConfigRepository.get();
    if (!vaultSession || !appConfig || !this.syncService.getDescriptor(account.accountId)) return;
    this.markDirty({
      accountId: account.accountId,
      deviceId: account.deviceId,
      ownerId,
      vaultSessionId,
      vaultKey: vaultSession.vaultKey,
      requestId: request.id
    });
  }

  markDirty(context: SyncMutationContext): void {
    if (this.stopped) return;
    const seen = this.requestIds.get(context.accountId) ?? new Set<string>();
    if (seen.has(context.requestId)) return;
    seen.add(context.requestId);
    this.requestIds.set(context.accountId, seen);
    this.dirtyAccounts.add(context.accountId);
    const generation = this.generations.get(context.accountId) ?? 0;
    const prior = this.queues.get(context.accountId) ?? Promise.resolve();
    const task = prior
      .then(async () => {
        if (!this.isActive(context.accountId, generation)) return;
        await this.process(context, generation);
      })
      .catch((error: unknown) => {
        if (this.isActive(context.accountId, generation)) this.recordFailure(context, error);
      });
    this.queues.set(context.accountId, task);
    void task.finally(() => {
      if (this.queues.get(context.accountId) === task) this.queues.delete(context.accountId);
      seen.delete(context.requestId);
      if (seen.size === 0) this.requestIds.delete(context.accountId);
    }).catch(() => undefined);
  }

  async retry(accountId: string): Promise<void> {
    if (this.stopped) return;
    this.clearRetryTimer(accountId);
    const generation = this.generations.get(accountId) ?? 0;
    const prior = this.queues.get(accountId) ?? Promise.resolve();
    const task = prior.then(async () => {
      if (!this.isActive(accountId, generation)) return;
      const state = this.syncService.getClientState(accountId);
      if (!state?.pendingEnvelope) return;
      try {
        await this.transport.push(accountId, state.pendingEnvelope, syncEnvelopeIdempotencyKey(accountId, state.pendingEnvelope));
        if (!this.isActive(accountId, generation)) return;
        this.syncService.markSynced(accountId);
        this.retryAttempts.delete(accountId);
        this.dirtyAccounts.delete(accountId);
      } catch (error) {
        if (this.isActive(accountId, generation)) this.recordFailureForAccount(accountId, error);
      }
    });
    this.queues.set(accountId, task);
    await task.catch(() => undefined);
    if (this.queues.get(accountId) === task) this.queues.delete(accountId);
  }

  async flush(accountId: string): Promise<void> {
    await this.queues.get(accountId)?.catch(() => undefined);
  }

  cancelAccount(accountId: string): void {
    this.generations.set(accountId, (this.generations.get(accountId) ?? 0) + 1);
    this.clearRetryTimer(accountId);
    const state = this.syncService.getClientState(accountId);
    if (this.dirtyAccounts.has(accountId) && !state?.pendingEnvelope) {
      this.syncService.savePending(accountId, null, 'needs-unlock', state?.errorCode ?? 'SESSION_INVALID');
    } else if (state?.status === 'syncing') {
      this.syncService.savePending(accountId, state.pendingEnvelope, 'pending', state.errorCode);
    }
    this.dirtyAccounts.delete(accountId);
  }

  cancelAll(): void {
    for (const accountId of new Set([...this.queues.keys(), ...this.requestIds.keys(), ...this.generations.keys(), ...this.dirtyAccounts])) {
      this.cancelAccount(accountId);
    }
  }

  close(): void {
    this.stopped = true;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    this.cancelAll();
  }

  private async process(context: SyncMutationContext, generation: number): Promise<void> {
    if (!this.isActive(context.accountId, generation)) return;
    if (!this.sessionStore.get(context.vaultSessionId)) {
      const state = this.syncService.getClientState(context.accountId);
      this.syncService.savePending(context.accountId, state?.pendingEnvelope ?? null, 'needs-unlock', state?.errorCode ?? 'SESSION_INVALID');
      return;
    }
    const envelope = await this.syncService.prepareEnvelope(context.accountId, context.ownerId, context.deviceId, context.vaultKey);
    if (!this.isActive(context.accountId, generation)) return;
    this.syncService.savePending(context.accountId, envelope, 'pending');
    await this.transport.push(context.accountId, envelope, syncEnvelopeIdempotencyKey(context.accountId, envelope));
    if (!this.isActive(context.accountId, generation)) return;
    this.syncService.markSynced(context.accountId);
    this.retryAttempts.delete(context.accountId);
    this.dirtyAccounts.delete(context.accountId);
  }

  private recordFailure(context: SyncMutationContext, error: unknown): void {
    this.recordFailureForAccount(context.accountId, error, context.vaultSessionId);
  }

  private recordFailureForAccount(accountId: string, error: unknown, vaultSessionId?: string): void {
    const code = errorCodeOf(error);
    if (code === 'SYNC_NOT_ENABLED' || code === 'SYNC_NOT_FOUND') {
      this.dirtyAccounts.delete(accountId);
      return;
    }
    const existing = this.syncService.getClientState(accountId)?.pendingEnvelope ?? null;
    if (vaultSessionId && !this.sessionStore.get(vaultSessionId)) {
      if (existing) this.syncService.savePending(accountId, existing, 'needs-unlock', code);
      return;
    }
    const status = code === 'ACCOUNT_DEVICE_REVOKED'
      ? 'device-revoked'
      : code === 'SYNC_CONFLICT' ? 'conflict' : isPermanentFailure(error) ? 'pending' : 'offline';
    this.syncService.savePending(accountId, existing, status, code);
    if (status === 'offline') this.scheduleRetry(accountId);
  }

  private scheduleRetry(accountId: string): void {
    if (this.stopped || this.retryTimers.has(accountId)) return;
    const attempt = (this.retryAttempts.get(accountId) ?? 0) + 1;
    this.retryAttempts.set(accountId, attempt);
    if (attempt > MAX_RETRY_ATTEMPTS) return;
    const delay = Math.min(this.retryMaxDelayMs, this.retryBaseDelayMs * (2 ** (attempt - 1)));
    const timer = setTimeout(() => {
      this.retryTimers.delete(accountId);
      void this.retry(accountId);
    }, delay);
    timer.unref?.();
    this.retryTimers.set(accountId, timer);
  }

  private clearRetryTimer(accountId: string): void {
    const timer = this.retryTimers.get(accountId);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(accountId);
  }

  private isActive(accountId: string, generation: number): boolean {
    return !this.stopped && (this.generations.get(accountId) ?? 0) === generation;
  }
}

export const createSyncService = (options: SyncServiceOptions): SyncService => new SyncService(options);

export const createDefaultBlindSyncStore = (database: ConstructorParameters<typeof BlindSyncRepository>[0]): BlindSyncRepository => (
  new BlindSyncRepository(database)
);
