import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import { TransferManager } from '../../../src/server/sftp/transfer-manager.js';
import type { SftpResource } from '../../../src/server/sftp/types.js';

const chunks = async function* (values: string[]): AsyncGenerator<Uint8Array> {
  for (const value of values) yield Buffer.from(value);
};

const fakeResource = (overrides: Partial<SftpResource> = {}): SftpResource & { writes: string[]; renamed: Array<[string, string]>; removed: string[] } => {
  const target = {
    writes: [],
    renamed: [],
    removed: [],
    async list() { return []; },
    async stat() { return null; },
    async mkdir() {},
    async rename(from: string, to: string) { target.renamed.push([from, to]); },
    async remove(path: string) { target.removed.push(path); },
    async rmdir() {},
    async writeFile(path: string, source: AsyncIterable<Uint8Array>, onProgress?: (bytes: number) => void) {
      target.writes.push(path);
      let completed = 0;
      for await (const chunk of source) { completed += chunk.byteLength; onProgress?.(completed); }
    },
    async readFile() { return chunks(['download']); },
    close() {}
  } satisfies SftpResource & { writes: string[]; renamed: Array<[string, string]>; removed: string[] };
  return Object.assign(target, overrides);
};

const resumableResource = (): SftpResource & { target: Buffer; temporary: Buffer; renamed: Array<[string, string]>; removed: string[]; failOnce: boolean } => {
  const target = {
    target: Buffer.alloc(0),
    temporary: Buffer.alloc(0),
    renamed: [],
    removed: [],
    failOnce: true,
    async list() { return []; },
    async stat(path: string) {
      if (path.includes('.relay-tmp-')) return { name: path.split('/').at(-1) ?? path, path, type: 'file' as const, size: target.temporary.byteLength, mode: null, modifiedAt: null };
      if (path === '/remote.txt' && target.target.byteLength > 0) return { name: 'remote.txt', path, type: 'file' as const, size: target.target.byteLength, mode: null, modifiedAt: null };
      return null;
    },
    async mkdir() {},
    async rename(from: string, to: string) {
      target.renamed.push([from, to]);
      target.target = target.temporary;
      target.temporary = Buffer.alloc(0);
    },
    async remove(path: string) {
      target.removed.push(path);
      if (path.includes('.relay-tmp-')) target.temporary = Buffer.alloc(0);
    },
    async rmdir() {},
    async writeFile(path: string, source: AsyncIterable<Uint8Array>, onProgress?: (bytes: number) => void, _signal?: AbortSignal, options?: { offset?: number }) {
      const offset = options?.offset ?? 0;
      if (offset === 0) target.temporary = Buffer.alloc(0);
      let completed = offset;
      for await (const chunk of source) {
        const value = Buffer.from(chunk);
        target.temporary = Buffer.concat([target.temporary.subarray(0, completed), value, target.temporary.subarray(completed + value.byteLength)]);
        completed += value.byteLength;
        onProgress?.(completed);
        if (target.failOnce) {
          target.failOnce = false;
          throw new AppError('SFTP_CONNECTION_FAILED');
        }
      }
    },
    async readFile(path: string, _signal?: AbortSignal, options?: { offset?: number; end?: number }) {
      const content = path.includes('.relay-tmp-') ? target.temporary : target.target;
      const start = options?.offset ?? 0;
      const end = options?.end ?? content.byteLength;
      return (async function* () { yield content.subarray(start, end); })();
    },
    close() {}
  } satisfies SftpResource & { target: Buffer; temporary: Buffer; renamed: Array<[string, string]>; removed: string[]; failOnce: boolean };
  return target;
};

describe('TransferManager', () => {
  it('writes uploads to a temporary path and atomically renames after completion', async () => {
    const nextResource = fakeResource();
    const manager = new TransferManager({ resourceProvider: { open: async () => ({ resource: nextResource, close: () => nextResource.close() }) } });
    const job = await manager.create({ kind: 'upload', hostId: 'host-1', sourcePath: 'local.txt', targetPath: '/remote.txt', totalBytes: 5 });
    const updates: number[] = [];
    const completed = await manager.consumeUpload(job.id, chunks(['he', 'llo']), (next) => updates.push(next.completedBytes));

    expect(completed.status).toBe('completed');
    expect(nextResource.writes[0]).toContain('.relay-tmp-');
    expect(nextResource.renamed[0]?.[1]).toBe('/remote.txt');
    expect(updates).toEqual([2, 5, 5]);
  });

  it('removes a temporary upload after failure and supports queued cancellation', async () => {
    const nextResource = fakeResource({
      writeFile: async () => { throw new AppError('SFTP_TRANSFER_FAILED'); }
    });
    const manager = new TransferManager({ resourceProvider: { open: async () => ({ resource: nextResource, close: () => nextResource.close() }) } });
    const failed = await manager.create({ kind: 'upload', hostId: 'host-1', sourcePath: 'local.txt', targetPath: '/remote.txt' });
    await expect(manager.consumeUpload(failed.id, chunks(['broken']))).rejects.toMatchObject({ code: 'SFTP_TRANSFER_FAILED' });
    expect(nextResource.removed[0]).toContain('.relay-tmp-');

    const queued = await manager.create({ kind: 'download', hostId: 'host-1', sourcePath: '/remote.txt', targetPath: 'local.txt' });
    await manager.cancel(queued.id);
    expect((await manager.get(queued.id))?.status).toBe('cancelled');
    await expect(manager.streamDownload(queued.id)).rejects.toMatchObject({ code: 'TRANSFER_CANCELLED' });
  });

  it('maps a remote permission error to a retryable user-facing SFTP error', async () => {
    const nextResource = fakeResource({
      writeFile: async () => { throw Object.assign(new Error('Permission denied'), { code: 3 }); }
    });
    const manager = new TransferManager({ resourceProvider: { open: async () => ({ resource: nextResource, close: () => nextResource.close() }) } });
    const job = await manager.create({ kind: 'upload', hostId: 'host-1', sourcePath: 'local.txt', targetPath: '/remote.txt' });

    await expect(manager.consumeUpload(job.id, chunks(['payload']))).rejects.toMatchObject({ code: 'SFTP_PERMISSION_DENIED' });
    expect((await manager.get(job.id))?.errorCode).toBe('SFTP_PERMISSION_DENIED');
  });

  it('streams downloads with progress, cancellation and retry state transitions', async () => {
    const nextResource = fakeResource();
    const manager = new TransferManager({ resourceProvider: { open: async () => ({ resource: nextResource, close: () => nextResource.close() }) } });
    const job = await manager.create({ kind: 'download', hostId: 'host-1', sourcePath: '/remote.txt', targetPath: 'local.txt' });
    const stream = await manager.streamDownload(job.id);
    const output: string[] = [];
    for await (const chunk of stream) output.push(Buffer.from(chunk).toString());
    expect(output).toEqual(['download']);
    expect((await manager.get(job.id))?.status).toBe('completed');
    await expect(manager.retry(job.id)).rejects.toMatchObject({ code: 'TRANSFER_CANCELLED' });
  });

  it('does not start a transfer cancelled while waiting for the host slot', async () => {
    let resolveFirstWriteStarted!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => { resolveFirstWriteStarted = resolve; });
    let releaseFirstWrite: (() => void) | undefined;
    let writeCount = 0;
    const nextResource = fakeResource({
      writeFile: async (path, source, onProgress) => {
        writeCount += 1;
        if (writeCount === 1) {
          resolveFirstWriteStarted();
          await new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
        }
        let completed = 0;
        for await (const chunk of source) {
          completed += chunk.byteLength;
          onProgress?.(completed);
        }
        void path;
      }
    });
    const manager = new TransferManager({
      maxConcurrentPerHost: 1,
      resourceProvider: { open: async () => ({ resource: nextResource, close: () => nextResource.close() }) }
    });
    const first = await manager.create({ kind: 'upload', hostId: 'host-1', sourcePath: 'one.txt', targetPath: '/one.txt' });
    const second = await manager.create({ kind: 'upload', hostId: 'host-1', sourcePath: 'two.txt', targetPath: '/two.txt' });
    const firstPromise = manager.consumeUpload(first.id, chunks(['one']));
    await firstWriteStarted;
    const secondPromise = manager.consumeUpload(second.id, chunks(['two']));

    await manager.cancel(second.id);
    releaseFirstWrite?.();
    await firstPromise;
    await expect(secondPromise).rejects.toMatchObject({ code: 'TRANSFER_CANCELLED' });
    expect(writeCount).toBe(1);
  });

  it('resumes a connection-interrupted upload from its verified checkpoint', async () => {
    const nextResource = resumableResource();
    const manager = new TransferManager({ resourceProvider: { open: async () => ({ resource: nextResource, close: () => nextResource.close() }) } });
    const job = await manager.create({ kind: 'upload', hostId: 'host-1', sourcePath: 'local.txt', targetPath: '/remote.txt', totalBytes: 11 });
    const source = () => chunks(['hello', ' world']);

    await expect(manager.consumeUpload(job.id, source())).rejects.toMatchObject({ code: 'SFTP_CONNECTION_FAILED' });
    const failed = await manager.get(job.id);
    expect(failed).toMatchObject({ status: 'failed', completedBytes: 5, checkpoint: { offset: 5 } });
    expect(nextResource.target).toHaveLength(0);

    const queued = await manager.retry(job.id);
    expect(queued).toMatchObject({ status: 'queued', completedBytes: 5, checkpoint: { offset: 5 } });
    const resumed = await manager.consumeUpload(job.id, source(), undefined, undefined, {
      transferId: job.id,
      expectedOffset: 5,
      checksum: failed?.checkpoint?.checksum ?? null
    });

    expect(resumed.status).toBe('completed');
    expect(nextResource.target.toString()).toBe('hello world');
    expect(createHash('sha256').update(nextResource.target).digest('hex')).toBe(resumed.checkpoint?.checksum);
  });

  it('resumes a connection-interrupted download from its verified remote prefix', async () => {
    const remote = Buffer.from('hello world');
    let failOnce = true;
    const nextResource: SftpResource = {
      async list() { return []; },
      async stat(path) { return path === '/remote.txt' ? { name: 'remote.txt', path, type: 'file', size: remote.byteLength, mode: null, modifiedAt: null } : null; },
      async mkdir() {},
      async rename() {},
      async remove() {},
      async rmdir() {},
      async writeFile() {},
      async readFile(_path, _signal, options) {
        const start = options?.offset ?? 0;
        const end = options?.end ?? remote.byteLength;
        return (async function* () {
          if (start === 0 && options?.end === undefined && failOnce) {
            failOnce = false;
            yield remote.subarray(0, 5);
            throw new AppError('SFTP_CONNECTION_FAILED');
          }
          yield remote.subarray(start, end);
        })();
      },
      close() {}
    };
    const manager = new TransferManager({ resourceProvider: { open: async () => ({ resource: nextResource, close() {} }) } });
    const job = await manager.create({ kind: 'download', hostId: 'host-1', sourcePath: '/remote.txt', targetPath: 'remote.txt', totalBytes: remote.byteLength });
    const firstStream = await manager.streamDownload(job.id);
    const firstOutput: Buffer[] = [];
    await expect((async () => {
      for await (const chunk of firstStream) firstOutput.push(Buffer.from(chunk));
    })()).rejects.toMatchObject({ code: 'SFTP_CONNECTION_FAILED' });
    const failed = await manager.get(job.id);
    expect(Buffer.concat(firstOutput).toString()).toBe('hello');
    expect(failed).toMatchObject({ status: 'failed', completedBytes: 5, checkpoint: { offset: 5 } });

    await manager.retry(job.id);
    const resumedStream = await manager.streamDownload(job.id, undefined, undefined, {
      transferId: job.id,
      expectedOffset: 5,
      checksum: failed?.checkpoint?.checksum ?? null
    });
    const resumedOutput: Buffer[] = [];
    for await (const chunk of resumedStream) resumedOutput.push(Buffer.from(chunk));

    expect(Buffer.concat(resumedOutput).toString()).toBe(' world');
    expect((await manager.get(job.id))?.status).toBe('completed');
    expect((await manager.get(job.id))?.checkpoint?.checksum).toBe(createHash('sha256').update(remote).digest('hex'));
  });

  it('accepts bounded upload chunks and only publishes the target after the final checksum matches', async () => {
    const nextResource = resumableResource();
    nextResource.failOnce = false;
    const manager = new TransferManager({ resourceProvider: { open: async () => ({ resource: nextResource, close: () => nextResource.close() }) } });
    const job = await manager.create({ kind: 'upload', hostId: 'host-1', sourcePath: 'local.txt', targetPath: '/remote.txt', totalBytes: 11 });
    const prefixChecksum = createHash('sha256').update('hello').digest('hex');
    const finalChecksum = createHash('sha256').update('hello world').digest('hex');

    const partial = await manager.consumeUploadChunk(job.id, chunks(['hello']), undefined, undefined, {
      transferId: job.id,
      expectedOffset: 0,
      checksum: null
    }, prefixChecksum, false);
    expect(partial).toMatchObject({ status: 'running', completedBytes: 5, checkpoint: { offset: 5, checksum: prefixChecksum } });
    expect(nextResource.target).toHaveLength(0);

    const completed = await manager.consumeUploadChunk(job.id, chunks([' world']), undefined, undefined, {
      transferId: job.id,
      expectedOffset: 5,
      checksum: prefixChecksum
    }, finalChecksum, true);
    expect(completed.status).toBe('completed');
    expect(nextResource.target.toString()).toBe('hello world');
    expect(completed.checkpoint?.checksum).toBe(finalChecksum);
  });
});
