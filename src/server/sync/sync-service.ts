import { randomUUID } from 'node:crypto';

import type {
  SyncDescriptor,
  SyncEnvelope,
  SyncHead,
  SyncPreview,
  SyncResolution,
  SyncState,
  VaultUnlockEnvelope
} from '../../shared/core/models.js';
import { AppError } from '../../shared/errors.js';
import { createSyncKey, decryptSyncPayload, encryptSyncPayload, unwrapSyncKey, wrapSyncKey } from './sync-crypto.js';
import { BlindSyncRepository, type BlindSyncStore } from './sync-repository.js';
import { SyncSnapshotService } from './sync-snapshot.js';
import type { VaultConfig } from '../vault/types.js';

export interface SyncServiceContract {
  status(accountId: string): SyncState;
  enable(accountId: string, ownerId: string, deviceId: string, vaultKey: Buffer, vaultConfig: VaultConfig): Promise<SyncHead>;
  pull(accountId: string): SyncEnvelope | null;
  push(accountId: string, envelope: SyncEnvelope, idempotencyKey: string): SyncHead;
  previewPull(accountId: string, ownerId: string, vaultKey: Buffer): Promise<SyncPreview>;
  resolveConflict(accountId: string, ownerId: string, vaultKey: Buffer, conflictId: string, resolution: SyncResolution): Promise<void>;
}

export interface SyncServiceOptions {
  store: BlindSyncStore;
  snapshotService: SyncSnapshotService;
}

const toVaultUnlockEnvelope = (vaultConfig: VaultConfig): VaultUnlockEnvelope => ({
  version: vaultConfig.version,
  kdf: { ...vaultConfig.kdf },
  wrappedVaultKey: vaultConfig.wrappedVaultKey
});

export class SyncService implements SyncServiceContract {
  private readonly store: BlindSyncStore;
  private readonly snapshotService: SyncSnapshotService;

  constructor(options: SyncServiceOptions) {
    this.store = options.store;
    this.snapshotService = options.snapshotService;
  }

  status(accountId: string): SyncState {
    const descriptor = this.store.getDescriptor(accountId);
    if (!descriptor) return { sync: 'local-only', head: null, pendingCount: 0 };
    const head = this.store.getHead(accountId);
    return head
      ? { sync: 'synced', head, pendingCount: 0, lastSyncedAt: head.updatedAt }
      : { sync: 'pending', head: null, pendingCount: 1 };
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
      return this.store.putEnvelope(accountId, envelope, `enable:${accountId}:${descriptor.vaultId}`);
    } finally {
      plaintext?.fill(0);
      syncKey.fill(0);
    }
  }

  pull(accountId: string): SyncEnvelope | null {
    return this.store.getEnvelope(accountId);
  }

  push(accountId: string, envelope: SyncEnvelope, idempotencyKey: string): SyncHead {
    return this.store.putEnvelope(accountId, envelope, idempotencyKey);
  }

  async previewPull(accountId: string, ownerId: string, vaultKey: Buffer): Promise<SyncPreview> {
    const descriptor = this.store.getDescriptor(accountId);
    if (!descriptor) throw new AppError('SYNC_NOT_ENABLED');
    const remote = this.store.getEnvelope(accountId);
    if (!remote) throw new AppError('SYNC_NOT_FOUND');
    const syncKey = unwrapSyncKey(vaultKey, descriptor.vaultId, descriptor.keyVersion, descriptor.wrappedSyncKey);
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptSyncPayload(syncKey, remote);
      const preview = await this.snapshotService.previewApply(ownerId, vaultKey, plaintext);
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
      this.store.resolveConflict(accountId, conflictId);
      return;
    }
    const descriptor = this.store.getDescriptor(accountId);
    if (!descriptor) throw new AppError('SYNC_NOT_ENABLED');
    const syncKey = unwrapSyncKey(vaultKey, descriptor.vaultId, descriptor.keyVersion, descriptor.wrappedSyncKey);
    let plaintext: Buffer | undefined;
    try {
      plaintext = decryptSyncPayload(syncKey, conflict.remote);
      await this.snapshotService.apply(ownerId, vaultKey, plaintext, 'use-remote');
      this.store.resolveConflict(accountId, conflictId);
    } finally {
      plaintext?.fill(0);
      syncKey.fill(0);
    }
  }
}

export const createSyncService = (options: SyncServiceOptions): SyncService => new SyncService(options);

export const createDefaultBlindSyncStore = (database: ConstructorParameters<typeof BlindSyncRepository>[0]): BlindSyncRepository => (
  new BlindSyncRepository(database)
);
