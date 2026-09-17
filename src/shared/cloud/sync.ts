import { decryptCloudSnapshot, encryptCloudSnapshot } from './snapshot-crypto.js';
import type { CloudSnapshotHead } from './client.js';
import type { CloudDataEnvelope, CloudDataDomain } from './protocol.js';

export const CLOUD_SYNC_DEFAULT_MAX_PLAINTEXT_BYTES = 8 * 1024 * 1024;
export const CLOUD_SYNC_MAX_PLAINTEXT_BYTES = 32 * 1024 * 1024;

interface CloudSnapshotApi {
  getAccountDataHead(token: string): Promise<CloudSnapshotHead | null>;
  getAccountDataSnapshot(token: string, revision?: number): Promise<CloudDataEnvelope>;
  putAccountDataSnapshot(token: string, envelope: CloudDataEnvelope, idempotencyKey: string): Promise<CloudSnapshotHead>;
  getWorkspaceHead(token: string, workspaceId: string): Promise<CloudSnapshotHead | null>;
  getWorkspaceSnapshot(token: string, workspaceId: string, revision?: number): Promise<CloudDataEnvelope>;
  putWorkspaceSnapshot(token: string, workspaceId: string, envelope: CloudDataEnvelope, idempotencyKey: string): Promise<CloudSnapshotHead>;
}

interface AccountSnapshotRef {
  domain: 'account-data';
  accountId: string;
  workspaceId?: undefined;
}

interface WorkspaceSnapshotRef {
  domain: 'workspace';
  accountId: string;
  workspaceId: string;
}

export type CloudSnapshotRef = AccountSnapshotRef | WorkspaceSnapshotRef;

export type PullCloudSnapshotInput = CloudSnapshotRef & {
  token: string;
  dataKey: Uint8Array;
};

export type PublishCloudSnapshotInput = CloudSnapshotRef & {
  token: string;
  writerDeviceId: string;
  keyVersion: number;
  parentRevision: number | null;
  plaintext: Uint8Array;
  dataKey: Uint8Array;
  idempotencyKey: string;
};

export interface PulledCloudSnapshot {
  head: CloudSnapshotHead;
  envelope: CloudDataEnvelope;
  plaintext: Uint8Array;
}

const assertPlaintext = (value: Uint8Array, maxBytes: number): void => {
  if (!(value instanceof Uint8Array) || value.byteLength > maxBytes) throw new Error('cloud snapshot too large');
};

const assertEnvelopeRef = (envelope: CloudDataEnvelope, ref: CloudSnapshotRef): void => {
  if (envelope.domain !== ref.domain || envelope.accountId !== ref.accountId) throw new Error('cloud snapshot scope mismatch');
  if (ref.domain === 'workspace' && envelope.workspaceId !== ref.workspaceId) throw new Error('cloud snapshot scope mismatch');
};

export class CloudSnapshotSyncEngine {
  private readonly maxPlaintextBytes: number;

  constructor(private readonly api: CloudSnapshotApi, options: { maxPlaintextBytes?: number } = {}) {
    this.maxPlaintextBytes = options.maxPlaintextBytes ?? CLOUD_SYNC_DEFAULT_MAX_PLAINTEXT_BYTES;
    if (!Number.isSafeInteger(this.maxPlaintextBytes) || this.maxPlaintextBytes < 1 || this.maxPlaintextBytes > CLOUD_SYNC_MAX_PLAINTEXT_BYTES) throw new Error('invalid cloud snapshot limit');
  }

  async pull(input: PullCloudSnapshotInput): Promise<PulledCloudSnapshot | null> {
    const head = input.domain === 'account-data'
      ? await this.api.getAccountDataHead(input.token)
      : await this.api.getWorkspaceHead(input.token, input.workspaceId);
    if (!head) return null;
    const envelope = input.domain === 'account-data'
      ? await this.api.getAccountDataSnapshot(input.token, head.revision)
      : await this.api.getWorkspaceSnapshot(input.token, input.workspaceId, head.revision);
    assertEnvelopeRef(envelope, input);
    const plaintext = await decryptCloudSnapshot(envelope, input.dataKey);
    assertPlaintext(plaintext, this.maxPlaintextBytes);
    return { head, envelope, plaintext };
  }

  async publish(input: PublishCloudSnapshotInput): Promise<CloudSnapshotHead> {
    assertPlaintext(input.plaintext, this.maxPlaintextBytes);
    const revision = (input.parentRevision ?? 0) + 1;
    const envelope = await encryptCloudSnapshot({
      domain: input.domain,
      accountId: input.accountId,
      ...(input.domain === 'workspace' ? { workspaceId: input.workspaceId } : {}),
      revision,
      parentRevision: input.parentRevision,
      writerDeviceId: input.writerDeviceId,
      keyVersion: input.keyVersion,
      dataKey: input.dataKey,
      plaintext: input.plaintext
    });
    const head = input.domain === 'account-data'
      ? await this.api.putAccountDataSnapshot(input.token, envelope, input.idempotencyKey)
      : await this.api.putWorkspaceSnapshot(input.token, input.workspaceId, envelope, input.idempotencyKey);
    if (head.domain !== envelope.domain || head.resourceId !== (input.domain === 'account-data' ? input.accountId : input.workspaceId) || head.revision !== envelope.revision || head.payloadHash !== envelope.payloadHash) {
      throw new Error('cloud snapshot response mismatch');
    }
    return head;
  }
}

export type { CloudDataDomain };
