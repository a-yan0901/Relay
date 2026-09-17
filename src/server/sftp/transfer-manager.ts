import { createHash, randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import { transitionTransfer } from '../../shared/core/state-machines.js';
import type { TransferCheckpoint, TransferJob, TransferRequest, TransferResumeRequest } from '../../shared/core/models.js';
import { parseTransferRequest } from '../../shared/validation.js';
import { TransferRepository, type OwnerIdProvider, resolveOwnerId } from '../db/repositories.js';
import type { SqliteDatabase } from '../db/database.js';
import type { TransferJobPatch, TransferJobRow } from '../db/types.js';
import type { SftpResourceProvider } from './sftp-service.js';
import { mapSftpError } from './error-mapping.js';
import { DEFAULT_OWNER_ID } from '../auth/owner-context.js';

export interface TransferManagerOptions {
  resourceProvider: SftpResourceProvider;
  ownerId?: OwnerIdProvider;
  database?: SqliteDatabase;
  repository?: TransferRepository;
  maxConcurrentPerHost?: number;
  maxBytes?: number;
  ttlMs?: number;
  now?: () => number;
}

interface ManagedTransfer {
  job: TransferJob;
  controller: AbortController;
  running: boolean;
  cancelRequested: boolean;
  pauseRequested: boolean;
  temporaryPath?: string;
  startedAtMs?: number;
  startedBytes?: number;
  checkpointVerified?: boolean;
}

interface UploadSourceState {
  sourceBytes: number;
  checksum: string;
  checksumAtOffset: string | null;
  pendingChecksums: string[];
}

interface DownloadPlan {
  offset: number;
  totalBytes: number | null;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const SHA256_HEX = /^[a-f0-9]{64}$/iu;

const timestamp = (now: () => number): string => new Date(now()).toISOString();

const sharedJobFromRow = (row: TransferJobRow): TransferJob => ({
  id: row.id,
  kind: row.kind,
  hostId: row.hostId,
  sourcePath: row.sourcePath,
  targetPath: row.targetPath,
  status: row.status,
  completedBytes: row.completedBytes,
  totalBytes: row.totalBytes,
  ...(row.errorCode === undefined ? {} : { errorCode: row.errorCode }),
  ...(row.checkpoint === undefined ? {} : { checkpoint: row.checkpoint }),
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

export class TransferManager {
  private readonly options: Required<Pick<TransferManagerOptions, 'maxConcurrentPerHost' | 'maxBytes' | 'ttlMs' | 'now'>> & Pick<TransferManagerOptions, 'resourceProvider' | 'ownerId'>;
  private readonly jobs = new Map<string, ManagedTransfer>();
  private readonly activeByHost = new Map<string, number>();
  private readonly waitersByHost = new Map<string, Array<() => void>>();
  private readonly repository?: TransferRepository;

  private get ownerId(): string { return resolveOwnerId(this.options.ownerId ?? DEFAULT_OWNER_ID); }

  constructor(options: TransferManagerOptions) {
    const maxConcurrentPerHost = options.maxConcurrentPerHost ?? 2;
    if (!Number.isInteger(maxConcurrentPerHost) || maxConcurrentPerHost < 1 || maxConcurrentPerHost > 8) throw new AppError('SFTP_TRANSFER_FAILED');
    this.options = {
      resourceProvider: options.resourceProvider,
      ownerId: options.ownerId,
      maxConcurrentPerHost,
      maxBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      ttlMs: options.ttlMs ?? DEFAULT_TTL_MS,
      now: options.now ?? Date.now
    };
    this.repository = options.repository ?? (options.database && options.ownerId ? new TransferRepository(options.database, options.ownerId) : undefined);
    this.repository?.markActiveInterrupted('SERVICE_RESTARTED', timestamp(this.options.now));
    this.repository?.deleteExpired(new Date(this.options.now() - this.options.ttlMs).toISOString());
    for (const job of this.repository?.list() ?? []) {
      const sharedJob = sharedJobFromRow(job);
      this.jobs.set(sharedJob.id, { job: sharedJob, controller: new AbortController(), running: false, cancelRequested: false, pauseRequested: false, checkpointVerified: false, temporaryPath: job.temporaryPath ?? undefined });
    }
  }

  async create(input: TransferRequest): Promise<TransferJob> {
    this.prune();
    const request = parseTransferRequest(input);
    const id = randomUUID();
    const now = timestamp(this.options.now);
    const job: TransferJob = {
      id,
      kind: request.kind,
      hostId: request.hostId,
      sourcePath: request.sourcePath,
      targetPath: request.targetPath,
      status: 'queued',
      completedBytes: 0,
      totalBytes: request.totalBytes ?? null,
      checkpoint: { transferId: id, offset: 0, totalBytes: request.totalBytes ?? null, checksum: null },
      createdAt: now,
      updatedAt: now
    };
    this.repository?.create({ ownerId: this.ownerId, ...job, checkpointOffset: 0, checkpointChecksum: null, temporaryPath: null });
    this.jobs.set(id, { job, controller: new AbortController(), running: false, cancelRequested: false, pauseRequested: false });
    return { ...job };
  }

  async consumeUpload(transferId: string, source: AsyncIterable<Uint8Array>, onUpdate?: (job: TransferJob) => void, sessionKey?: Buffer, resume?: TransferResumeRequest): Promise<TransferJob> {
    const managed = this.require(transferId);
    if (managed.job.kind !== 'upload') throw new AppError('TRANSFER_NOT_FOUND');
    if (managed.job.status === 'cancelled') throw new AppError('TRANSFER_CANCELLED');
    if (managed.job.status !== 'queued') throw new AppError('TRANSFER_NOT_FOUND');
    let temporaryPath: string | undefined;
    try {
      const result = await this.run(managed, async (resource) => {
        temporaryPath = this.temporaryPath(managed.job);
        managed.temporaryPath = temporaryPath;
        this.persist(managed, { temporaryPath });

        let { offset, checksum } = this.requestedCheckpoint(managed.job, resume);
        if (offset > 0 && !(await this.verifyCheckpoint(resource, temporaryPath, offset, checksum, managed.controller.signal, true))) {
          await resource.remove(temporaryPath);
          this.resetCheckpoint(managed);
          offset = 0;
          checksum = null;
        }
        managed.checkpointVerified = true;
        this.setCheckpoint(managed, offset, checksum);
        this.update(managed, 'running');

        const sourceState: UploadSourceState = {
          sourceBytes: 0,
          checksum: this.emptyChecksum(),
          checksumAtOffset: null,
          pendingChecksums: []
        };
        const boundedSource = this.resumableSource(source, offset, checksum, sourceState, (completedBytes) => {
          if (completedBytes > this.options.maxBytes) throw new AppError('FILE_TOO_LARGE');
        }, managed.controller.signal);
        await resource.writeFile(temporaryPath, boundedSource, (completedBytes) => {
          const absoluteCompletedBytes = completedBytes < offset ? offset + completedBytes : completedBytes;
          if (absoluteCompletedBytes > this.options.maxBytes) throw new AppError('FILE_TOO_LARGE');
          const nextChecksum = sourceState.pendingChecksums.shift();
          if (nextChecksum !== undefined) this.progress(managed, absoluteCompletedBytes, nextChecksum, onUpdate);
        }, managed.controller.signal, { offset, truncate: offset === 0 });
        if (managed.controller.signal.aborted || managed.cancelRequested) throw new AppError('TRANSFER_CANCELLED');
        if (managed.job.totalBytes !== null && sourceState.sourceBytes !== managed.job.totalBytes) throw new AppError('TRANSFER_RESUME_INVALID');
        this.setCheckpoint(managed, sourceState.sourceBytes, sourceState.checksum);
        await resource.rename(temporaryPath, managed.job.targetPath);
        temporaryPath = undefined;
        managed.temporaryPath = undefined;
        this.persist(managed, { temporaryPath: null });
        this.update(managed, 'completed');
        onUpdate?.(managed.job);
        return managed.job;
      }, sessionKey);
      return { ...result };
    } catch (error) {
      const mappedError = mapSftpError(error);
      const preserveTemporary = (managed.pauseRequested || mappedError.code === 'SFTP_CONNECTION_FAILED') && temporaryPath !== undefined;
      if (temporaryPath && !preserveTemporary) {
        await this.removeTemporaryPath(managed.job.hostId, temporaryPath, sessionKey);
      }
      if (managed.pauseRequested) {
        if ((managed.job.status as TransferJob['status']) !== 'paused') this.update(managed, 'paused');
      } else if (managed.cancelRequested || managed.controller.signal.aborted || error instanceof AppError && error.code === 'TRANSFER_CANCELLED') {
        this.resetCheckpoint(managed);
        this.clearTemporary(managed);
        if ((managed.job.status as TransferJob['status']) !== 'cancelled') this.update(managed, 'cancelled');
      } else {
        if (!preserveTemporary) {
          this.resetCheckpoint(managed);
          this.clearTemporary(managed);
        }
        this.fail(managed, mappedError.code);
      }
      onUpdate?.(managed.job);
      throw mappedError;
    }
  }

  async consumeUploadChunk(transferId: string, source: AsyncIterable<Uint8Array>, onUpdate: ((job: TransferJob) => void) | undefined, sessionKey: Buffer | undefined, resume: TransferResumeRequest, nextChecksum: string, final: boolean): Promise<TransferJob> {
    const managed = this.require(transferId);
    if (managed.job.kind !== 'upload') throw new AppError('TRANSFER_NOT_FOUND');
    if (managed.job.status === 'cancelled') throw new AppError('TRANSFER_CANCELLED');
    if (managed.job.status !== 'queued' && managed.job.status !== 'running') throw new AppError('TRANSFER_NOT_FOUND');
    if (managed.running) throw new AppError('SFTP_TRANSFER_FAILED', '传输正在处理另一块数据');
    if (!SHA256_HEX.test(nextChecksum)) throw new AppError('TRANSFER_RESUME_INVALID');

    const requested = this.requestedCheckpointWithMode(managed.job, resume, true);
    const temporaryPath = this.temporaryPath(managed.job);
    managed.temporaryPath = temporaryPath;
    this.persist(managed, { temporaryPath });
    try {
      const result = await this.run(managed, async (resource) => {
        if (requested.offset > 0 && !managed.checkpointVerified) {
          const valid = await this.verifyCheckpoint(resource, temporaryPath, requested.offset, requested.checksum, managed.controller.signal, true);
          if (!valid) {
            await resource.remove(temporaryPath).catch(() => undefined);
            this.resetCheckpoint(managed);
            managed.checkpointVerified = false;
            throw new AppError('TRANSFER_RESUME_INVALID');
          }
          managed.checkpointVerified = true;
        }
        if (requested.offset === 0) managed.checkpointVerified = true;
        if (managed.job.status === 'queued') this.update(managed, 'running');

        let chunkBytes = 0;
        const maxBytes = this.options.maxBytes;
        const countedSource = (async function* (): AsyncGenerator<Uint8Array> {
          for await (const chunk of source) {
            if (managed.controller.signal.aborted || managed.cancelRequested) throw new AppError('TRANSFER_CANCELLED');
            const value = Buffer.from(chunk);
            chunkBytes += value.byteLength;
            if (requested.offset + chunkBytes > (managed.job.totalBytes ?? Number.MAX_SAFE_INTEGER) || requested.offset + chunkBytes > maxBytes) throw new AppError('FILE_TOO_LARGE');
            yield value;
          }
        }).call(this);
        await resource.writeFile(temporaryPath, countedSource, undefined, managed.controller.signal, { offset: requested.offset, truncate: requested.offset === 0 });
        if (managed.controller.signal.aborted || managed.cancelRequested) throw new AppError('TRANSFER_CANCELLED');
        if (chunkBytes === 0 && !final) throw new AppError('TRANSFER_RESUME_INVALID');
        const nextOffset = requested.offset + chunkBytes;
        if (managed.job.totalBytes !== null && nextOffset > managed.job.totalBytes) throw new AppError('TRANSFER_RESUME_INVALID');
        if (!final && managed.job.totalBytes !== null && nextOffset >= managed.job.totalBytes) throw new AppError('TRANSFER_RESUME_INVALID');

        const checkpointChecksum = final ? await this.hashFile(resource, temporaryPath, managed.controller.signal) : nextChecksum.toLowerCase();
        if (checkpointChecksum !== nextChecksum.toLowerCase()) throw new AppError('TRANSFER_RESUME_INVALID');
        this.setCheckpoint(managed, nextOffset, checkpointChecksum);
        if (final) {
          if (managed.job.totalBytes !== null && nextOffset !== managed.job.totalBytes) throw new AppError('TRANSFER_RESUME_INVALID');
          await resource.rename(temporaryPath, managed.job.targetPath);
          managed.temporaryPath = undefined;
          this.persist(managed, { temporaryPath: null });
          this.update(managed, 'completed');
        }
        onUpdate?.(managed.job);
        return managed.job;
      }, sessionKey);
      return { ...result };
    } catch (error) {
      const mappedError = mapSftpError(error);
      const preserveTemporary = managed.pauseRequested || mappedError.code === 'SFTP_CONNECTION_FAILED';
      if (!preserveTemporary) {
        await this.removeTemporaryPath(managed.job.hostId, temporaryPath, sessionKey);
      }
      if (managed.pauseRequested) {
        if ((managed.job.status as TransferJob['status']) !== 'paused') this.update(managed, 'paused');
      } else if (managed.cancelRequested || managed.controller.signal.aborted || error instanceof AppError && error.code === 'TRANSFER_CANCELLED') {
        this.resetCheckpoint(managed);
        this.clearTemporary(managed);
        managed.checkpointVerified = false;
        if ((managed.job.status as TransferJob['status']) !== 'cancelled') this.update(managed, 'cancelled');
      } else {
        if (!preserveTemporary) {
          this.resetCheckpoint(managed);
          this.clearTemporary(managed);
          managed.checkpointVerified = false;
        }
        this.fail(managed, mappedError.code);
      }
      onUpdate?.(managed.job);
      throw mappedError;
    }
  }

  async streamDownload(transferId: string, sessionKey?: Buffer, onUpdate?: (job: TransferJob) => void, resume?: TransferResumeRequest): Promise<AsyncIterable<Uint8Array>> {
    const managed = this.require(transferId);
    if (managed.job.kind !== 'download') throw new AppError('TRANSFER_NOT_FOUND');
    if (managed.job.status === 'cancelled') throw new AppError('TRANSFER_CANCELLED');
    if (managed.job.status !== 'queued') throw new AppError('TRANSFER_NOT_FOUND');
    const plan = await this.prepareDownload(managed, sessionKey, resume);
    return this.downloadGenerator(managed, sessionKey, onUpdate, plan);
  }

  async pause(transferId: string, _sessionKey?: Buffer): Promise<void> {
    const managed = this.require(transferId);
    if (managed.job.status === 'completed' || managed.job.status === 'failed' || managed.job.status === 'cancelled' || managed.job.status === 'interrupted' || managed.job.status === 'paused') return;
    managed.pauseRequested = true;
    managed.cancelRequested = false;
    managed.controller.abort();
    if (managed.job.status === 'queued' || (managed.job.status === 'running' && !managed.running)) this.update(managed, 'paused');
  }

  async cancel(transferId: string, sessionKey?: Buffer): Promise<void> {
    const managed = this.require(transferId);
    if (managed.job.status === 'completed' || managed.job.status === 'failed' || managed.job.status === 'cancelled' || managed.job.status === 'interrupted') return;
    managed.cancelRequested = true;
    managed.pauseRequested = false;
    managed.controller.abort();
    if (managed.job.status === 'queued' || managed.job.status === 'paused' || (managed.job.status === 'running' && !managed.running)) {
      if (managed.temporaryPath) {
        await this.removeTemporaryPath(managed.job.hostId, managed.temporaryPath, sessionKey);
        this.clearTemporary(managed);
      }
      this.resetCheckpoint(managed);
      if ((managed.job.status as TransferJob['status']) !== 'cancelled') this.update(managed, 'cancelled');
    }
  }

  async retry(transferId: string): Promise<TransferJob> {
    const managed = this.require(transferId);
    if (managed.job.status !== 'failed' && managed.job.status !== 'paused' && managed.job.status !== 'interrupted') throw new AppError('TRANSFER_CANCELLED');
    managed.controller = new AbortController();
    managed.cancelRequested = false;
    managed.pauseRequested = false;
    managed.startedAtMs = undefined;
    managed.startedBytes = undefined;
    managed.checkpointVerified = false;
    managed.job = { ...managed.job, status: 'queued', completedBytes: managed.job.checkpoint?.offset ?? managed.job.completedBytes, errorCode: undefined, speedBytesPerSecond: undefined, etaSeconds: undefined, updatedAt: timestamp(this.options.now) };
    this.persist(managed, { status: 'queued', completedBytes: managed.job.completedBytes, errorCode: null, updatedAt: managed.job.updatedAt });
    return { ...managed.job };
  }

  async get(transferId: string): Promise<TransferJob | null> {
    this.prune();
    const managed = this.jobs.get(transferId);
    return managed ? { ...managed.job } : null;
  }

  async list(): Promise<readonly TransferJob[]> {
    this.prune();
    return [...this.jobs.values()].map(({ job }) => ({ ...job }));
  }

  private async *downloadGenerator(managed: ManagedTransfer, sessionKey: Buffer | undefined, onUpdate: ((job: TransferJob) => void) | undefined, plan: DownloadPlan): AsyncGenerator<Uint8Array> {
    const lease = await this.acquire(managed.job.hostId, sessionKey, managed.controller.signal);
    managed.running = true;
    try {
      const hash = createHash('sha256');
      if (plan.offset > 0) {
        const prefix = await lease.resource.readFile(managed.job.sourcePath, managed.controller.signal, { offset: 0, end: plan.offset });
        let prefixBytes = 0;
        for await (const chunk of prefix) {
          const value = Buffer.from(chunk);
          const remaining = plan.offset - prefixBytes;
          if (remaining <= 0) break;
          const accepted = value.subarray(0, remaining);
          hash.update(accepted);
          prefixBytes += accepted.byteLength;
        }
        if (prefixBytes !== plan.offset) throw new AppError('TRANSFER_RESUME_INVALID');
      }
      this.update(managed, 'running');
      onUpdate?.(managed.job);
      const source = await lease.resource.readFile(managed.job.sourcePath, managed.controller.signal, { offset: plan.offset });
      let completed = plan.offset;
      if (plan.offset === 0 && completed === 0) this.setCheckpoint(managed, 0, this.emptyChecksum());
      for await (const chunk of source) {
        if (managed.controller.signal.aborted || managed.cancelRequested) throw new AppError('TRANSFER_CANCELLED');
        const value = Buffer.from(chunk);
        completed += value.byteLength;
        if (completed > this.options.maxBytes) throw new AppError('FILE_TOO_LARGE');
        hash.update(value);
        this.progress(managed, completed, hash.copy().digest('hex'), onUpdate);
        yield value;
      }
      if (managed.job.totalBytes !== null && completed !== managed.job.totalBytes) throw new AppError('TRANSFER_RESUME_INVALID');
      this.update(managed, 'completed');
      onUpdate?.(managed.job);
    } catch (error) {
      const mappedError = mapSftpError(error);
      if (managed.pauseRequested) {
        if (managed.job.status !== 'paused') this.update(managed, 'paused');
      } else if (managed.cancelRequested || managed.controller.signal.aborted || error instanceof AppError && error.code === 'TRANSFER_CANCELLED') {
        this.resetCheckpoint(managed);
        this.clearTemporary(managed);
        if (managed.job.status !== 'cancelled') this.update(managed, 'cancelled');
      } else {
        if (mappedError.code !== 'SFTP_CONNECTION_FAILED') this.resetCheckpoint(managed);
        this.fail(managed, mappedError.code);
      }
      onUpdate?.(managed.job);
      throw mappedError;
    } finally {
      await lease.close();
      this.release(managed.job.hostId);
      managed.running = false;
    }
  }

  private async run<T>(managed: ManagedTransfer, operation: (resource: Awaited<ReturnType<SftpResourceProvider['open']>>['resource']) => Promise<T>, sessionKey?: Buffer): Promise<T> {
    const lease = await this.acquire(managed.job.hostId, sessionKey, managed.controller.signal);
    managed.running = true;
    try {
      return await operation(lease.resource);
    } finally {
      await lease.close();
      this.release(managed.job.hostId);
      managed.running = false;
    }
  }

  private async acquire(hostId: string, sessionKey?: Buffer, signal?: AbortSignal): Promise<Awaited<ReturnType<SftpResourceProvider['open']>>> {
    const active = this.activeByHost.get(hostId) ?? 0;
    if (active >= this.options.maxConcurrentPerHost) {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let waiter: () => void;
        const cleanup = (): void => signal?.removeEventListener('abort', onAbort);
        const onAbort = (): void => {
          if (settled) return;
          settled = true;
          const waiters = this.waitersByHost.get(hostId) ?? [];
          const remaining = waiters.filter((candidate) => candidate !== waiter);
          if (remaining.length === 0) this.waitersByHost.delete(hostId);
          else this.waitersByHost.set(hostId, remaining);
          cleanup();
          reject(new AppError('TRANSFER_CANCELLED'));
        };
        waiter = () => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve();
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        this.waitersByHost.set(hostId, [...(this.waitersByHost.get(hostId) ?? []), waiter]);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    if (signal?.aborted) throw new AppError('TRANSFER_CANCELLED');
    this.activeByHost.set(hostId, (this.activeByHost.get(hostId) ?? 0) + 1);
    try {
      return sessionKey === undefined
        ? await this.options.resourceProvider.open(hostId)
        : await this.options.resourceProvider.open(hostId, sessionKey);
    } catch (error) {
      this.release(hostId);
      throw error;
    }
  }

  private release(hostId: string): void {
    const next = Math.max(0, (this.activeByHost.get(hostId) ?? 1) - 1);
    if (next === 0) this.activeByHost.delete(hostId);
    else this.activeByHost.set(hostId, next);
    const waiter = this.waitersByHost.get(hostId)?.shift();
    if (waiter) waiter();
  }

  private emptyChecksum(): string {
    return createHash('sha256').digest('hex');
  }

  private checkpoint(job: TransferJob): TransferCheckpoint {
    return job.checkpoint ?? {
      transferId: job.id,
      offset: job.completedBytes,
      totalBytes: job.totalBytes,
      checksum: null
    };
  }

  private temporaryPath(job: TransferJob): string {
    return `${job.targetPath}.relay-tmp-${job.id}`;
  }

  private requestedCheckpoint(job: TransferJob, resume?: TransferResumeRequest): { offset: number; checksum: string | null } {
    return this.requestedCheckpointWithMode(job, resume, false);
  }

  private requestedCheckpointWithMode(job: TransferJob, resume: TransferResumeRequest | undefined, strict: boolean): { offset: number; checksum: string | null } {
    const checkpoint = this.checkpoint(job);
    if (resume === undefined) return { offset: checkpoint.offset, checksum: checkpoint.checksum };
    if (resume.transferId !== job.id || !Number.isSafeInteger(resume.expectedOffset) || resume.expectedOffset < 0) throw new AppError('TRANSFER_RESUME_INVALID');
    if (resume.checksum !== null && !SHA256_HEX.test(resume.checksum)) throw new AppError('TRANSFER_RESUME_INVALID');
    const checksum = resume.checksum?.toLowerCase() ?? null;
    if (resume.expectedOffset !== checkpoint.offset || checksum !== checkpoint.checksum) {
      if (strict) throw new AppError('TRANSFER_RESUME_INVALID');
      return { offset: 0, checksum: null };
    }
    return { offset: checkpoint.offset, checksum };
  }

  private async hashFile(resource: Awaited<ReturnType<SftpResourceProvider['open']>>['resource'], path: string, signal: AbortSignal): Promise<string> {
    const hash = createHash('sha256');
    const source = await resource.readFile(path, signal);
    for await (const chunk of source) {
      if (signal.aborted) throw new AppError('TRANSFER_CANCELLED');
      hash.update(Buffer.from(chunk));
    }
    return hash.digest('hex');
  }

  private async verifyCheckpoint(resource: Awaited<ReturnType<SftpResourceProvider['open']>>['resource'], path: string, offset: number, expectedChecksum: string | null, signal: AbortSignal, exactSize: boolean): Promise<boolean> {
    if (offset === 0) return true;
    if (expectedChecksum === null || !SHA256_HEX.test(expectedChecksum)) return false;
    try {
      const stat = await resource.stat(path);
      if (!stat || stat.type !== 'file' || (exactSize ? stat.size !== offset : stat.size < offset)) return false;
      const source = await resource.readFile(path, signal, { offset: 0, end: offset });
      const hash = createHash('sha256');
      let bytes = 0;
      for await (const chunk of source) {
        const remaining = offset - bytes;
        if (remaining <= 0) break;
        const value = Buffer.from(chunk).subarray(0, remaining);
        hash.update(value);
        bytes += value.byteLength;
      }
      return bytes === offset && hash.digest('hex') === expectedChecksum.toLowerCase();
    } catch (error) {
      if (mapSftpError(error).code === 'SFTP_NOT_FOUND') return false;
      throw error;
    }
  }

  private setTotal(managed: ManagedTransfer, totalBytes: number | null): void {
    if (managed.job.totalBytes === totalBytes && this.checkpoint(managed.job).totalBytes === totalBytes) return;
    const current = this.checkpoint(managed.job);
    managed.job = {
      ...managed.job,
      totalBytes,
      checkpoint: { ...current, totalBytes },
      updatedAt: timestamp(this.options.now)
    };
    this.persist(managed, { totalBytes, updatedAt: managed.job.updatedAt });
  }

  private setCheckpoint(managed: ManagedTransfer, offset: number, checksum: string | null): void {
    const totalBytes = managed.job.totalBytes;
    const checkpoint: TransferCheckpoint = {
      transferId: managed.job.id,
      offset,
      totalBytes,
      checksum: checksum?.toLowerCase() ?? null
    };
    managed.job = {
      ...managed.job,
      completedBytes: offset,
      checkpoint,
      updatedAt: timestamp(this.options.now)
    };
    this.persist(managed, {
      completedBytes: offset,
      checkpointOffset: offset,
      checkpointChecksum: checkpoint.checksum,
      updatedAt: managed.job.updatedAt
    });
  }

  private resetCheckpoint(managed: ManagedTransfer): void {
    this.setCheckpoint(managed, 0, null);
  }

  private persist(managed: ManagedTransfer, patch: TransferJobPatch): void {
    this.repository?.update(managed.job.id, patch);
  }

  private async prepareDownload(managed: ManagedTransfer, sessionKey: Buffer | undefined, resume?: TransferResumeRequest): Promise<DownloadPlan> {
    const requested = this.requestedCheckpoint(managed.job, resume);
    const lease = await this.acquire(managed.job.hostId, sessionKey, managed.controller.signal);
    try {
      const stat = await lease.resource.stat(managed.job.sourcePath);
      const totalBytes = stat?.type === 'file' ? stat.size : managed.job.totalBytes;
      if (totalBytes !== managed.job.totalBytes) this.setTotal(managed, totalBytes);
      let offset = requested.offset;
      let checksum = requested.checksum;
      const checkpoint = this.checkpoint(managed.job);
      const sameFile = checkpoint.totalBytes === null || totalBytes === null || checkpoint.totalBytes === totalBytes;
      if (offset > 0 && (!sameFile || !(await this.verifyCheckpoint(lease.resource, managed.job.sourcePath, offset, checksum, managed.controller.signal, false)))) {
        offset = 0;
        checksum = null;
      }
      if (offset !== checkpoint.offset || checksum !== checkpoint.checksum) this.setCheckpoint(managed, offset, checksum);
      return { offset, totalBytes };
    } finally {
      await lease.close();
      this.release(managed.job.hostId);
    }
  }

  private resumableSource(source: AsyncIterable<Uint8Array>, offset: number, expectedChecksum: string | null, state: UploadSourceState, onProgress: (completedBytes: number) => void, signal: AbortSignal): AsyncIterable<Uint8Array> {
    return (async function* (): AsyncGenerator<Uint8Array> {
      const hash = createHash('sha256');
      const prefixHash = createHash('sha256');
      let sourceBytes = 0;
      for await (const chunk of source) {
        if (signal.aborted) throw new AppError('TRANSFER_CANCELLED');
        const value = Buffer.from(chunk);
        if (value.byteLength === 0) continue;
        const chunkStart = sourceBytes;
        if (offset > chunkStart) prefixHash.update(value.subarray(0, Math.min(value.byteLength, offset - chunkStart)));
        hash.update(value);
        sourceBytes += value.byteLength;
        if (offset > 0 && state.checksumAtOffset === null && sourceBytes >= offset) {
          state.checksumAtOffset = prefixHash.copy().digest('hex');
          if (expectedChecksum !== null && state.checksumAtOffset !== expectedChecksum) throw new AppError('TRANSFER_RESUME_INVALID');
        }
        const skip = Math.max(0, Math.min(value.byteLength, offset - chunkStart));
        const output = value.subarray(skip);
        const checksum = hash.copy().digest('hex');
        state.sourceBytes = sourceBytes;
        state.checksum = checksum;
        if (output.byteLength > 0) {
          state.pendingChecksums.push(checksum);
          onProgress(sourceBytes);
          yield output;
        }
      }
      state.sourceBytes = sourceBytes;
      state.checksum = hash.copy().digest('hex');
      if (offset > 0 && state.checksumAtOffset === null && sourceBytes >= offset) state.checksumAtOffset = prefixHash.copy().digest('hex');
    })();
  }

  private progress(managed: ManagedTransfer, completedBytes: number, checksum: string | null, onUpdate?: (job: TransferJob) => void): void {
    if (managed.job.totalBytes !== null && completedBytes > managed.job.totalBytes) throw new AppError('TRANSFER_RESUME_INVALID');
    const checkpointOffset = Math.max(managed.job.checkpoint?.offset ?? 0, completedBytes);
    const state = transitionTransfer({ id: managed.job.id, status: managed.job.status, completedBytes: managed.job.completedBytes, totalBytes: managed.job.totalBytes, checkpointOffset: managed.job.checkpoint?.offset, errorCode: managed.job.errorCode }, { type: 'progress', completedBytes, checkpointOffset });
    const nextOffset = state.checkpointOffset ?? state.completedBytes;
    const nowMs = this.options.now();
    const elapsedMs = Math.max(0, nowMs - (managed.startedAtMs ?? nowMs));
    const startedBytes = managed.startedBytes ?? 0;
    const speedBytesPerSecond = elapsedMs > 0 && state.completedBytes > startedBytes
      ? (state.completedBytes - startedBytes) / (elapsedMs / 1000)
      : managed.job.speedBytesPerSecond;
    const etaSeconds = speedBytesPerSecond !== undefined && speedBytesPerSecond > 0 && state.totalBytes !== null
      ? Math.max(0, Math.ceil((state.totalBytes - state.completedBytes) / speedBytesPerSecond))
      : managed.job.etaSeconds;
    managed.job = {
      ...managed.job,
      completedBytes: state.completedBytes,
      checkpoint: { transferId: managed.job.id, offset: nextOffset, totalBytes: state.totalBytes, checksum },
      ...(speedBytesPerSecond === undefined ? {} : { speedBytesPerSecond }),
      ...(etaSeconds === undefined ? {} : { etaSeconds }),
      updatedAt: timestamp(this.options.now)
    };
    this.persist(managed, { completedBytes: managed.job.completedBytes, checkpointOffset: nextOffset, checkpointChecksum: checksum, updatedAt: managed.job.updatedAt });
    onUpdate?.(managed.job);
  }

  private update(managed: ManagedTransfer, status: 'running' | 'paused' | 'completed' | 'cancelled'): void {
    if (status === 'running' && managed.startedAtMs === undefined) {
      managed.startedAtMs = this.options.now();
      managed.startedBytes = managed.job.completedBytes;
    }
    const event = status === 'running' ? { type: 'start' as const, totalBytes: managed.job.totalBytes } : status === 'paused' ? { type: 'paused' as const } : status === 'completed' ? { type: 'completed' as const } : { type: 'cancelled' as const };
    const state = transitionTransfer({ id: managed.job.id, status: managed.job.status, completedBytes: managed.job.completedBytes, totalBytes: managed.job.totalBytes, errorCode: managed.job.errorCode }, event);
    managed.job = { ...managed.job, status: state.status, completedBytes: state.completedBytes, totalBytes: state.totalBytes, errorCode: state.errorCode, etaSeconds: state.status === 'completed' ? 0 : managed.job.etaSeconds, updatedAt: timestamp(this.options.now) };
    this.persist(managed, { status: managed.job.status, completedBytes: managed.job.completedBytes, totalBytes: managed.job.totalBytes, errorCode: managed.job.errorCode ?? null, checkpointOffset: managed.job.checkpoint?.offset ?? managed.job.completedBytes, checkpointChecksum: managed.job.checkpoint?.checksum ?? null, updatedAt: managed.job.updatedAt });
  }

  private fail(managed: ManagedTransfer, code: string): void {
    if (managed.job.status !== 'queued' && managed.job.status !== 'running') return;
    managed.job = { ...managed.job, status: 'failed', errorCode: code, updatedAt: timestamp(this.options.now) };
    this.persist(managed, { status: managed.job.status, errorCode: code, updatedAt: managed.job.updatedAt });
  }

  private async removeTemporaryPath(hostId: string, path: string, sessionKey?: Buffer): Promise<void> {
    try {
      const lease = sessionKey === undefined
        ? await this.options.resourceProvider.open(hostId)
        : await this.options.resourceProvider.open(hostId, sessionKey);
      try {
        await lease.resource.remove(path);
      } finally {
        await lease.close();
      }
    } catch { /* cleanup is best effort */ }
  }

  private clearTemporary(managed: ManagedTransfer): void {
    if (managed.temporaryPath === undefined) return;
    managed.temporaryPath = undefined;
    this.persist(managed, { temporaryPath: null });
  }

  private require(transferId: string): ManagedTransfer {
    this.prune();
    const managed = this.jobs.get(transferId);
    if (!managed) throw new AppError('TRANSFER_NOT_FOUND');
    return managed;
  }

  private prune(): void {
    const cutoff = this.options.now() - this.options.ttlMs;
    for (const [id, managed] of this.jobs) {
      if (!managed.running && Date.parse(managed.job.updatedAt) <= cutoff) this.jobs.delete(id);
    }
    this.repository?.deleteExpired(new Date(cutoff).toISOString());
  }
}
