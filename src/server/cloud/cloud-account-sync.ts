import { Sha256 } from '../../shared/crypto/sha256.js';
import { AppError } from '../../shared/errors.js';
import { CloudKeyManager, type CloudKeyManagerApi, type CloudKeyMaterial } from '../../shared/cloud/key-manager.js';
import { CloudSnapshotSyncEngine } from '../../shared/cloud/sync.js';
import type { CloudSnapshotHead } from '../../shared/cloud/client.js';
import type { CloudDeviceKeyPair } from '../../shared/cloud/key-crypto.js';

export interface CloudAccountSnapshotPort {
  create(vaultKey: Buffer): Promise<Uint8Array>;
  /** Used only for first-login bootstrap; it must not inspect or return secrets. */
  isEmpty(plaintext: Uint8Array): boolean;
  apply(vaultKey: Buffer, plaintext: Uint8Array): Promise<void>;
}

export interface CloudAccountSyncCursor {
  remoteRevision: number;
  remotePayloadHash: string;
  localPayloadHash: string;
}

export type CloudAccountSyncStatus = 'initialized' | 'pulled' | 'pushed' | 'synced' | 'conflict';

export interface CloudAccountSyncResult {
  status: CloudAccountSyncStatus;
  head: CloudSnapshotHead | null;
  cursor: CloudAccountSyncCursor | null;
}

export interface CloudAccountSyncContext {
  token: string;
  accountId: string;
  deviceId: string;
  deviceKeyPair: CloudDeviceKeyPair;
  vaultKey: Buffer;
  cursor: CloudAccountSyncCursor | null;
}

export interface CloudAccountSyncOptions {
  keyManager?: CloudKeyManager;
  snapshotEngine?: CloudSnapshotSyncEngine;
  maxPlaintextBytes?: number;
}

const MAX_CURSOR_REVISION = 1_000_000_000;
const MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;

const assertCursor = (cursor: CloudAccountSyncCursor | null): void => {
  if (cursor === null) return;
  if (
    !Number.isSafeInteger(cursor.remoteRevision) || cursor.remoteRevision < 1 || cursor.remoteRevision > MAX_CURSOR_REVISION
    || !/^[a-f0-9]{64}$/u.test(cursor.remotePayloadHash)
    || !/^[a-f0-9]{64}$/u.test(cursor.localPayloadHash)
  ) throw new Error('invalid cloud account sync cursor');
};

const payloadHash = (plaintext: Uint8Array): string => new Sha256().update(plaintext).digestHex();

const copyCursor = (cursor: CloudAccountSyncCursor): CloudAccountSyncCursor => ({ ...cursor });

/**
 * Synchronizes only the account-level encrypted snapshot. Device workspace
 * state is intentionally outside this class. It never retains plaintext or
 * data keys after `run` returns.
 */
export class CloudAccountSyncCoordinator {
  private readonly keyManager?: CloudKeyManager;
  private readonly snapshotEngine: CloudSnapshotSyncEngine;
  private readonly maxPlaintextBytes: number;

  constructor(
    private readonly api: CloudKeyManagerApi & ConstructorParameters<typeof CloudSnapshotSyncEngine>[0],
    private readonly snapshot: CloudAccountSnapshotPort,
    options: CloudAccountSyncOptions = {}
  ) {
    this.keyManager = options.keyManager;
    const maxPlaintextBytes = options.maxPlaintextBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(maxPlaintextBytes) || maxPlaintextBytes < 1 || maxPlaintextBytes > MAX_PLAINTEXT_BYTES) throw new Error('invalid cloud account snapshot limit');
    this.maxPlaintextBytes = maxPlaintextBytes;
    this.snapshotEngine = options.snapshotEngine ?? new CloudSnapshotSyncEngine(this.api, { maxPlaintextBytes });
  }

  async run(context: CloudAccountSyncContext): Promise<CloudAccountSyncResult> {
    assertCursor(context.cursor);
    if (!Buffer.isBuffer(context.vaultKey) || context.vaultKey.length === 0) throw new AppError('VAULT_CRYPTO_FAILED');
    const ownsKeyManager = this.keyManager === undefined;
    const keyManager = this.keyManager ?? new CloudKeyManager(this.api, {
      token: context.token,
      accountId: context.accountId,
      deviceId: context.deviceId,
      deviceKeyPair: context.deviceKeyPair
    });
    const engine = this.snapshotEngine;
    let material: CloudKeyMaterial | undefined;
    let local: Uint8Array | undefined;
    let remote: Awaited<ReturnType<CloudSnapshotSyncEngine['pull']>> | null = null;
    try {
      material = await keyManager.ensureAccountDataKey();
      local = await this.snapshot.create(context.vaultKey);
      if (!(local instanceof Uint8Array) || local.byteLength === 0 || local.byteLength > this.maxPlaintextBytes) throw new AppError('SYNC_PAYLOAD_INVALID');
      const localHash = payloadHash(local);
      remote = await engine.pull({ domain: 'account-data', accountId: context.accountId, token: context.token, dataKey: material.key });

      if (!remote) {
        const head = await engine.publish({
          domain: 'account-data', accountId: context.accountId, token: context.token, writerDeviceId: context.deviceId,
          keyVersion: material.keyVersion, parentRevision: null, plaintext: local, dataKey: material.key,
          idempotencyKey: `cloud-account:${context.deviceId}:${localHash}`
        });
        const cursor = { remoteRevision: head.revision, remotePayloadHash: head.payloadHash, localPayloadHash: localHash };
        return { status: 'initialized', head, cursor };
      }

      if (!context.cursor) {
        if (remote.head.payloadHash === localHash) {
          const cursor = { remoteRevision: remote.head.revision, remotePayloadHash: remote.head.payloadHash, localPayloadHash: localHash };
          return { status: 'synced', head: remote.head, cursor };
        }
        if (!this.snapshot.isEmpty(local)) return { status: 'conflict', head: remote.head, cursor: null };
        await this.snapshot.apply(context.vaultKey, remote.plaintext);
        const cursor = { remoteRevision: remote.head.revision, remotePayloadHash: remote.head.payloadHash, localPayloadHash: remote.head.payloadHash };
        return { status: 'pulled', head: remote.head, cursor };
      }

      const remoteChanged = context.cursor.remoteRevision !== remote.head.revision || context.cursor.remotePayloadHash !== remote.head.payloadHash;
      const localChanged = context.cursor.localPayloadHash !== localHash;
      if (!remoteChanged && !localChanged) return { status: 'synced', head: remote.head, cursor: copyCursor(context.cursor) };
      if (remoteChanged && localChanged) return { status: 'conflict', head: remote.head, cursor: copyCursor(context.cursor) };

      if (remoteChanged) {
        await this.snapshot.apply(context.vaultKey, remote.plaintext);
        const cursor = { remoteRevision: remote.head.revision, remotePayloadHash: remote.head.payloadHash, localPayloadHash: remote.head.payloadHash };
        return { status: 'pulled', head: remote.head, cursor };
      }

      const head = await engine.publish({
        domain: 'account-data', accountId: context.accountId, token: context.token, writerDeviceId: context.deviceId,
        keyVersion: material.keyVersion, parentRevision: remote.head.revision, plaintext: local, dataKey: material.key,
        idempotencyKey: `cloud-account:${context.deviceId}:${localHash}`
      });
      const cursor = { remoteRevision: head.revision, remotePayloadHash: head.payloadHash, localPayloadHash: localHash };
      return { status: 'pushed', head, cursor };
    } finally {
      material?.key.fill(0);
      if (local instanceof Uint8Array) local.fill(0);
      if (remote?.plaintext instanceof Uint8Array) remote.plaintext.fill(0);
      if (ownsKeyManager) keyManager.clear();
    }
  }
}
