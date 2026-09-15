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
});
