import { randomUUID } from 'node:crypto';

import { AppError } from '../../shared/errors.js';
import { transitionTransfer } from '../../shared/core/state-machines.js';
import type { TransferJob, TransferRequest } from '../../shared/core/models.js';
import { parseTransferRequest } from '../../shared/validation.js';
import { TransferRepository } from '../db/repositories.js';
import type { SqliteDatabase } from '../db/database.js';
import type { TransferJobRow } from '../db/types.js';
import type { SftpResourceProvider } from './sftp-service.js';
import { mapSftpError } from './error-mapping.js';

export interface TransferManagerOptions {
  resourceProvider: SftpResourceProvider;
  ownerId?: string;
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
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_TTL_MS = 15 * 60 * 1000;

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
  createdAt: row.createdAt,
  updatedAt: row.updatedAt
});

export class TransferManager {
  private readonly options: Required<Pick<TransferManagerOptions, 'maxConcurrentPerHost' | 'maxBytes' | 'ttlMs' | 'now'>> & Pick<TransferManagerOptions, 'resourceProvider' | 'ownerId'>;
  private readonly jobs = new Map<string, ManagedTransfer>();
  private readonly activeByHost = new Map<string, number>();
  private readonly waitersByHost = new Map<string, Array<() => void>>();
  private readonly repository?: TransferRepository;

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
      this.jobs.set(sharedJob.id, { job: sharedJob, controller: new AbortController(), running: false, cancelRequested: false });
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
      createdAt: now,
      updatedAt: now
    };
    this.repository?.create({ ownerId: this.options.ownerId ?? 'default', ...job });
    this.jobs.set(id, { job, controller: new AbortController(), running: false, cancelRequested: false });
    return { ...job };
  }

  async consumeUpload(transferId: string, source: AsyncIterable<Uint8Array>, onUpdate?: (job: TransferJob) => void, sessionKey?: Buffer): Promise<TransferJob> {
    const managed = this.require(transferId);
    if (managed.job.kind !== 'upload') throw new AppError('TRANSFER_NOT_FOUND');
    if (managed.job.status === 'cancelled') throw new AppError('TRANSFER_CANCELLED');
    if (managed.job.status !== 'queued') throw new AppError('TRANSFER_NOT_FOUND');
    let temporaryPath: string | undefined;
    try {
      const result = await this.run(managed, async (resource) => {
        temporaryPath = `${managed.job.targetPath}.relay-tmp-${managed.job.id}`;
        this.update(managed, 'running');
        let bytes = 0;
        const boundedSource = this.countedSource(source, (completedBytes) => {
          bytes = completedBytes;
          if (bytes > this.options.maxBytes) throw new AppError('FILE_TOO_LARGE');
          this.progress(managed, bytes, onUpdate);
        }, managed.controller.signal);
        await resource.writeFile(temporaryPath, boundedSource, (completedBytes) => {
          if (completedBytes > this.options.maxBytes) throw new AppError('FILE_TOO_LARGE');
        }, managed.controller.signal);
        if (managed.controller.signal.aborted || managed.cancelRequested) throw new AppError('TRANSFER_CANCELLED');
        await resource.rename(temporaryPath, managed.job.targetPath);
        temporaryPath = undefined;
        this.update(managed, 'completed');
        onUpdate?.(managed.job);
        return managed.job;
      }, sessionKey);
      return { ...result };
    } catch (error) {
      const mappedError = mapSftpError(error);
      if (temporaryPath) {
        try {
          const lease = sessionKey === undefined
            ? await this.options.resourceProvider.open(managed.job.hostId)
            : await this.options.resourceProvider.open(managed.job.hostId, sessionKey);
          await lease.resource.remove(temporaryPath);
          await lease.close();
        } catch { /* cleanup is best effort */ }
      }
      if (managed.cancelRequested || managed.controller.signal.aborted || error instanceof AppError && error.code === 'TRANSFER_CANCELLED') {
        if ((managed.job.status as TransferJob['status']) !== 'cancelled') this.update(managed, 'cancelled');
      }
      else this.fail(managed, mappedError.code);
      onUpdate?.(managed.job);
      throw mappedError;
    }
  }

  async streamDownload(transferId: string, sessionKey?: Buffer, onUpdate?: (job: TransferJob) => void): Promise<AsyncIterable<Uint8Array>> {
    const managed = this.require(transferId);
    if (managed.job.kind !== 'download') throw new AppError('TRANSFER_NOT_FOUND');
    if (managed.job.status === 'cancelled') throw new AppError('TRANSFER_CANCELLED');
    if (managed.job.status !== 'queued') throw new AppError('TRANSFER_NOT_FOUND');
    return this.downloadGenerator(managed, sessionKey, onUpdate);
  }

  async cancel(transferId: string): Promise<void> {
    const managed = this.require(transferId);
    if (managed.job.status === 'completed' || managed.job.status === 'failed' || managed.job.status === 'cancelled' || managed.job.status === 'interrupted') return;
    managed.cancelRequested = true;
    managed.controller.abort();
    if (managed.job.status === 'queued') this.update(managed, 'cancelled');
  }

  async retry(transferId: string): Promise<TransferJob> {
    const managed = this.require(transferId);
    if (managed.job.status !== 'failed' && managed.job.status !== 'interrupted') throw new AppError('TRANSFER_CANCELLED');
    managed.controller = new AbortController();
    managed.cancelRequested = false;
    managed.job = { ...managed.job, status: 'queued', completedBytes: 0, errorCode: undefined, updatedAt: timestamp(this.options.now) };
    this.repository?.update(transferId, { status: 'queued', completedBytes: 0, errorCode: null, updatedAt: managed.job.updatedAt });
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

  private async *downloadGenerator(managed: ManagedTransfer, sessionKey?: Buffer, onUpdate?: (job: TransferJob) => void): AsyncGenerator<Uint8Array> {
    const lease = await this.acquire(managed.job.hostId, sessionKey, managed.controller.signal);
    managed.running = true;
    try {
      this.update(managed, 'running');
      onUpdate?.(managed.job);
      const source = await lease.resource.readFile(managed.job.sourcePath, managed.controller.signal);
      let completed = 0;
      for await (const chunk of source) {
        if (managed.controller.signal.aborted || managed.cancelRequested) throw new AppError('TRANSFER_CANCELLED');
        const value = Buffer.from(chunk);
        completed += value.byteLength;
        if (completed > this.options.maxBytes) throw new AppError('FILE_TOO_LARGE');
        this.progress(managed, completed, onUpdate);
        yield value;
      }
      this.update(managed, 'completed');
      onUpdate?.(managed.job);
    } catch (error) {
      const mappedError = mapSftpError(error);
      if (managed.cancelRequested || managed.controller.signal.aborted || error instanceof AppError && error.code === 'TRANSFER_CANCELLED') {
        if (managed.job.status !== 'cancelled') this.update(managed, 'cancelled');
      }
      else this.fail(managed, mappedError.code);
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

  private countedSource(source: AsyncIterable<Uint8Array>, onProgress: (bytes: number) => void, signal: AbortSignal): AsyncIterable<Uint8Array> {
    return (async function* (): AsyncGenerator<Uint8Array> {
      let completed = 0;
      for await (const chunk of source) {
        if (signal.aborted) throw new AppError('TRANSFER_CANCELLED');
        const value = Buffer.from(chunk);
        completed += value.byteLength;
        onProgress(completed);
        yield value;
      }
    })();
  }

  private progress(managed: ManagedTransfer, completedBytes: number, onUpdate?: (job: TransferJob) => void): void {
    const state = transitionTransfer({ id: managed.job.id, status: managed.job.status, completedBytes: managed.job.completedBytes, totalBytes: managed.job.totalBytes, errorCode: managed.job.errorCode }, { type: 'progress', completedBytes });
    managed.job = { ...managed.job, completedBytes: state.completedBytes, updatedAt: timestamp(this.options.now) };
    this.repository?.update(managed.job.id, { completedBytes: managed.job.completedBytes, updatedAt: managed.job.updatedAt });
    onUpdate?.(managed.job);
  }

  private update(managed: ManagedTransfer, status: 'running' | 'completed' | 'cancelled'): void {
    const event = status === 'running' ? { type: 'start' as const, totalBytes: managed.job.totalBytes } : status === 'completed' ? { type: 'completed' as const } : { type: 'cancelled' as const };
    const state = transitionTransfer({ id: managed.job.id, status: managed.job.status, completedBytes: managed.job.completedBytes, totalBytes: managed.job.totalBytes, errorCode: managed.job.errorCode }, event);
    managed.job = { ...managed.job, status: state.status, completedBytes: state.completedBytes, totalBytes: state.totalBytes, errorCode: state.errorCode, updatedAt: timestamp(this.options.now) };
    this.repository?.update(managed.job.id, { status: managed.job.status, completedBytes: managed.job.completedBytes, totalBytes: managed.job.totalBytes, errorCode: managed.job.errorCode ?? null, updatedAt: managed.job.updatedAt });
  }

  private fail(managed: ManagedTransfer, code: string): void {
    if (managed.job.status !== 'queued' && managed.job.status !== 'running') return;
    managed.job = { ...managed.job, status: 'failed', errorCode: code, updatedAt: timestamp(this.options.now) };
    this.repository?.update(managed.job.id, { status: managed.job.status, errorCode: code, updatedAt: managed.job.updatedAt });
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
