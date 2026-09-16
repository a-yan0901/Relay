import { Buffer } from 'node:buffer';

import { AppError } from '../../shared/errors.js';
import { isActivityStatus, type ActivityStatus, type CommandRun } from '../../shared/core/models.js';
import { summarizeCommandTargets } from '../../shared/core/command-results.js';
import type { AuditEventInput, AuditEventRow, AuditListFilter, AuditMetadata } from '../db/types.js';
import { AuditRepository } from '../db/repositories.js';

export interface AuditRecordInput extends Omit<AuditEventInput, 'metadata'> {
  metadata?: Readonly<Record<string, unknown>>;
}

export interface AuditListInput {
  cursor?: string;
  limit?: number;
  eventType?: string;
  hostId?: string;
  requestId?: string;
  status?: ActivityStatus;
  from?: string;
  to?: string;
}

export interface PaginatedAuditEvents {
  items: AuditEventRow[];
  nextCursor?: string;
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const EVENT_PATTERN = /^[a-z][a-z0-9._-]{1,63}$/u;
const ALLOWED_METADATA = new Set(['runId', 'transferId', 'accountId', 'deviceId', 'vaultId', 'action', 'resolution', 'reason', 'status', 'targetCount', 'successCount', 'failureCount', 'cancelledCount', 'interruptedCount', 'anomalyCount', 'truncatedCount', 'durationMs', 'revision']);

const assertId = (value: string): void => {
  if (!ID_PATTERN.test(value)) throw new AppError('AUDIT_METADATA_INVALID');
};

const sanitizeMetadata = (input: Readonly<Record<string, unknown>> | undefined): AuditMetadata | undefined => {
  if (input === undefined) return undefined;
  const metadata: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED_METADATA.has(key)) throw new AppError('AUDIT_METADATA_INVALID');
    if (key === 'runId' || key === 'transferId' || key === 'accountId' || key === 'deviceId' || key === 'vaultId') {
      if (typeof value !== 'string') throw new AppError('AUDIT_METADATA_INVALID');
      assertId(value);
      metadata[key] = value;
      continue;
    }
    if (key === 'action' || key === 'resolution' || key === 'reason') {
      if (typeof value !== 'string' || !/^[a-z][a-z0-9._-]{1,63}$/u.test(value)) throw new AppError('AUDIT_METADATA_INVALID');
      metadata[key] = value;
      continue;
    }
    if (key === 'status') {
      if (!isActivityStatus(value)) throw new AppError('AUDIT_METADATA_INVALID');
      metadata[key] = value;
      continue;
    }
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AppError('AUDIT_METADATA_INVALID');
    metadata[key] = value;
  }
  return metadata;
};

const normalizeTimestamp = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new AppError('AUDIT_METADATA_INVALID');
  return new Date(timestamp).toISOString();
};

const encodeCursor = (cursor: { createdAt: string; id: string; sequence?: number }): string => Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');

const decodeCursor = (cursor: string | undefined): AuditListFilter['cursor'] | undefined => {
  if (cursor === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || !('createdAt' in parsed) || !('id' in parsed)) throw new Error('cursor');
    const value = parsed as { createdAt?: unknown; id?: unknown };
    const rawSequence = 'sequence' in (parsed as Record<string, unknown>) ? (parsed as { sequence?: unknown }).sequence : undefined;
    const sequence = typeof rawSequence === 'number' ? rawSequence : undefined;
    if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt)) || typeof value.id !== 'string' || (rawSequence !== undefined && (typeof rawSequence !== 'number' || !Number.isSafeInteger(rawSequence) || rawSequence < 1))) throw new Error('cursor');
    assertId(value.id);
    return { createdAt: value.createdAt, id: value.id, ...(sequence === undefined ? {} : { sequence }) };
  } catch {
    throw new AppError('AUDIT_METADATA_INVALID');
  }
};

export class AuditService {
  constructor(private readonly repository: AuditRepository) {}

  async record(input: AuditRecordInput): Promise<AuditEventRow> {
    if (!EVENT_PATTERN.test(input.eventType) || !ID_PATTERN.test(input.requestId)) throw new AppError('AUDIT_METADATA_INVALID');
    return this.repository.insert({ ...input, metadata: sanitizeMetadata(input.metadata) });
  }

  async list(input: AuditListInput = {}): Promise<PaginatedAuditEvents> {
    const limit = input.limit === undefined ? 50 : input.limit;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new AppError('AUDIT_METADATA_INVALID');
    if (input.eventType !== undefined && !EVENT_PATTERN.test(input.eventType)) throw new AppError('AUDIT_METADATA_INVALID');
    if (input.hostId !== undefined) assertId(input.hostId);
    if (input.requestId !== undefined) assertId(input.requestId);
    if (input.status !== undefined && !isActivityStatus(input.status)) throw new AppError('AUDIT_METADATA_INVALID');
    const from = normalizeTimestamp(input.from);
    const to = normalizeTimestamp(input.to);
    if (from !== undefined && to !== undefined && from > to) throw new AppError('AUDIT_METADATA_INVALID');
    const result = this.repository.list({
      cursor: decodeCursor(input.cursor),
      limit,
      eventType: input.eventType,
      hostId: input.hostId,
      requestId: input.requestId,
      status: input.status,
      from,
      to
    });
    return {
      items: result.items,
      ...(result.hasMore && result.nextCursor ? { nextCursor: encodeCursor(result.nextCursor) } : {})
    };
  }

  async recordCommandSummary(run: CommandRun): Promise<AuditEventRow> {
    const summary = summarizeCommandTargets(run.targets);
    const durationMs = run.finishedAt === undefined ? 0 : Math.max(0, Date.parse(run.finishedAt) - Date.parse(run.createdAt));
    const status: ActivityStatus = run.status === 'completed' ? 'succeeded' : run.status;
    return this.record({
      eventType: 'command_run_summary',
      requestId: run.requestId ?? run.id,
      metadata: {
        runId: run.id,
        status,
        targetCount: summary.total,
        successCount: summary.completed,
        failureCount: summary.failed,
        cancelledCount: summary.cancelled,
        interruptedCount: summary.interrupted,
        anomalyCount: summary.anomalyCount,
        truncatedCount: summary.truncatedCount,
        durationMs
      }
    });
  }
}
