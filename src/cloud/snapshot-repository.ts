import { createHash } from 'node:crypto';

import type { CloudDataDomain, CloudDataEnvelope } from '../shared/cloud/protocol.js';
import { parseCloudDataEnvelope } from '../shared/cloud/protocol.js';
import { AppError } from '../shared/errors.js';
import type { CloudSqlExecutor, CloudSqlTransaction } from './database.js';

export interface CloudRevisionInput {
  revision: number;
  parentRevision: number | null;
}

export const assertCloudRevisionChain = (currentRevision: number | null, input: CloudRevisionInput): number => {
  const expectedRevision = currentRevision === null ? 1 : currentRevision + 1;
  if (input.revision !== expectedRevision || input.parentRevision !== currentRevision) {
    throw new AppError('SYNC_CONFLICT');
  }
  return input.revision;
};

export interface CloudSnapshotHead {
  domain: CloudDataDomain;
  resourceId: string;
  revision: number;
  payloadHash: string;
  keyVersion: number;
  updatedAt: string;
}

export interface PutCloudSnapshotInput {
  accountId: string;
  workspaceId?: string;
  writerDeviceId: string;
  envelope: CloudDataEnvelope;
  idempotencyKeyHash: string;
  now: string;
}

export const hashCloudIdempotencyKey = (value: string): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw new AppError('SYNC_PAYLOAD_INVALID');
  }
  return createHash('sha256').update(value, 'utf8').digest('hex');
};

interface HeadSqlRow {
  revision: number;
  payload_hash: string;
  key_version: number;
  updated_at: string;
}

interface RevisionSqlRow {
  revision: number;
  parent_revision: number | null;
  writer_device_id: string;
  key_version: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  aad: string;
  payload_hash: string;
  byte_length: number;
}

interface CloudSnapshotDatabase extends CloudSqlExecutor {
  transaction?<T>(work: (transaction: CloudSqlTransaction) => Promise<T>): Promise<T>;
}

const tableNames = (domain: CloudDataDomain): { heads: string; revisions: string; idColumn: 'account_id' | 'workspace_id' } => (
  domain === 'account-data'
    ? { heads: 'account_data_heads', revisions: 'account_data_revisions', idColumn: 'account_id' }
    : { heads: 'workspace_heads', revisions: 'workspace_revisions', idColumn: 'workspace_id' }
);

const headFromRow = (domain: CloudDataDomain, resourceId: string, row: HeadSqlRow): CloudSnapshotHead => ({
  domain,
  resourceId,
  revision: row.revision,
  payloadHash: row.payload_hash,
  keyVersion: row.key_version,
  updatedAt: row.updated_at
});

const envelopeFromRow = (
  accountId: string,
  domain: CloudDataDomain,
  workspaceId: string | undefined,
  row: RevisionSqlRow
): CloudDataEnvelope => parseCloudDataEnvelope({
  protocolVersion: 1,
  domain,
  accountId,
  ...(workspaceId === undefined ? {} : { workspaceId }),
  revision: row.revision,
  parentRevision: row.parent_revision,
  writerDeviceId: row.writer_device_id,
  keyVersion: row.key_version,
  nonce: row.nonce,
  ciphertext: row.ciphertext,
  authTag: row.auth_tag,
  aad: row.aad,
  payloadHash: row.payload_hash,
  byteLength: row.byte_length
});

export class CloudSnapshotRepository {
  constructor(private readonly database: CloudSnapshotDatabase) {}

  async getHead(domain: CloudDataDomain, resourceId: string): Promise<CloudSnapshotHead | null> {
    const names = tableNames(domain);
    const rows = await this.database.query<HeadSqlRow[]>(
      `SELECT revision, payload_hash, key_version, updated_at FROM ${names.heads} WHERE ${names.idColumn} = ? LIMIT 1`,
      [resourceId]
    );
    const row = rows[0];
    return row ? headFromRow(domain, resourceId, row) : null;
  }

  async getRevision(accountId: string, domain: CloudDataDomain, resourceId: string, revision?: number): Promise<CloudDataEnvelope | null> {
    const names = tableNames(domain);
    const scope = revision === undefined
      ? `SELECT revision, parent_revision, writer_device_id, key_version, nonce, ciphertext, auth_tag, aad, payload_hash, byte_length FROM ${names.revisions} WHERE ${names.idColumn} = ? ORDER BY revision DESC LIMIT 1`
      : `SELECT revision, parent_revision, writer_device_id, key_version, nonce, ciphertext, auth_tag, aad, payload_hash, byte_length FROM ${names.revisions} WHERE ${names.idColumn} = ? AND revision = ? LIMIT 1`;
    const rows = await this.database.query<RevisionSqlRow[]>(scope, revision === undefined ? [resourceId] : [resourceId, revision]);
    const row = rows[0];
    return row ? envelopeFromRow(accountId, domain, domain === 'workspace' ? resourceId : undefined, row) : null;
  }

  async put(input: PutCloudSnapshotInput): Promise<CloudSnapshotHead> {
    const envelope = parseCloudDataEnvelope(input.envelope);
    if (
      envelope.accountId !== input.accountId ||
      envelope.domain !== (input.workspaceId === undefined ? 'account-data' : 'workspace') ||
      (envelope.domain === 'workspace' && envelope.workspaceId !== input.workspaceId) ||
      envelope.writerDeviceId !== input.writerDeviceId
    ) {
      throw new AppError('SYNC_PAYLOAD_INVALID');
    }
    const domain = envelope.domain;
    const resourceId = domain === 'workspace' ? input.workspaceId! : input.accountId;
    const write = async (executor: CloudSqlExecutor): Promise<CloudSnapshotHead> => this.putInTransaction(executor, input, envelope, domain, resourceId);
    if (this.database.transaction) return this.database.transaction(write);
    return write(this.database);
  }

  private async putInTransaction(
    executor: CloudSqlExecutor,
    input: PutCloudSnapshotInput,
    envelope: CloudDataEnvelope,
    domain: CloudDataDomain,
    resourceId: string
  ): Promise<CloudSnapshotHead> {
    const names = tableNames(domain);
    const idempotentRows = await executor.query<Array<{ revision: number }>>(
      `SELECT revision FROM ${names.revisions} WHERE ${names.idColumn} = ? AND idempotency_key_hash = ? LIMIT 1`,
      [resourceId, input.idempotencyKeyHash]
    );
    const current = await executor.query<HeadSqlRow[]>(
      `SELECT revision, payload_hash, key_version, updated_at FROM ${names.heads} WHERE ${names.idColumn} = ? FOR UPDATE`,
      [resourceId]
    );
    const currentRow = current[0];
    const currentHead = currentRow ? headFromRow(domain, resourceId, currentRow) : null;
    if (idempotentRows[0]) return currentHead ?? headFromRow(domain, resourceId, {
      revision: idempotentRows[0].revision,
      payload_hash: envelope.payloadHash,
      key_version: envelope.keyVersion,
      updated_at: input.now
    });

    assertCloudRevisionChain(currentHead?.revision ?? null, envelope);
    await executor.execute(
      `INSERT INTO ${names.revisions} (${names.idColumn}, revision, parent_revision, writer_device_id, key_version, nonce, ciphertext, auth_tag, aad, payload_hash, byte_length, idempotency_key_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        resourceId,
        envelope.revision,
        envelope.parentRevision,
        envelope.writerDeviceId,
        envelope.keyVersion,
        envelope.nonce,
        envelope.ciphertext,
        envelope.authTag,
        envelope.aad,
        envelope.payloadHash,
        envelope.byteLength,
        input.idempotencyKeyHash,
        input.now
      ]
    );
    await executor.execute(
      `INSERT INTO ${names.heads} (${names.idColumn}, revision, payload_hash, key_version, updated_at) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE revision = VALUES(revision), payload_hash = VALUES(payload_hash), key_version = VALUES(key_version), updated_at = VALUES(updated_at)`,
      [resourceId, envelope.revision, envelope.payloadHash, envelope.keyVersion, input.now]
    );
    return {
      domain,
      resourceId,
      revision: envelope.revision,
      payloadHash: envelope.payloadHash,
      keyVersion: envelope.keyVersion,
      updatedAt: input.now
    };
  }
}
