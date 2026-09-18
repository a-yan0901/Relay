import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import { AppError } from '../../shared/errors.js';
import type { SftpEntry } from '../../shared/core/models.js';
import type { SshConnectionResource, SshSftpResource } from '../ssh/types.js';
import type { SftpReadOptions, SftpResource, SftpResourceListPage, SftpWriteOptions } from './types.js';

interface RawSftpAttributes {
  mode?: number;
  size?: number;
  mtime?: number;
}

interface RawSftpEntry {
  filename: string;
  longname?: string;
  attrs: RawSftpAttributes;
}

interface RawStreamOptions {
  flags?: string;
  start?: number;
  end?: number;
}

interface RawSftpResource {
  opendir?(path: string, callback: (error: Error | undefined, handle: Buffer) => void): void;
  readdir(location: string | Buffer, callback: (error: Error | undefined, entries: RawSftpEntry[]) => void): void;
  close?(handle: Buffer, callback: (error?: Error) => void): void;
  stat(path: string, callback: (error: Error | undefined, attrs: RawSftpAttributes) => void): void;
  mkdir(path: string, callback: (error: Error | undefined) => void): void;
  rename(from: string, to: string, callback: (error: Error | undefined) => void): void;
  unlink(path: string, callback: (error: Error | undefined) => void): void;
  rmdir(path: string, callback: (error: Error | undefined) => void): void;
  createReadStream(path: string, options?: RawStreamOptions): Readable;
  createWriteStream(path: string, options?: RawStreamOptions): Writable;
  end?(): void;
}

const callbackOperation = <T>(operation: (callback: (error: Error | undefined, value: T) => void) => void): Promise<T> => new Promise<T>((resolve, reject) => {
  try {
    operation((error, value) => error ? reject(error) : resolve(value));
  } catch (error) {
    reject(error);
  }
});

const callbackVoid = (operation: (callback: (error: Error | undefined) => void) => void): Promise<void> => callbackOperation<void>((callback) => operation((error) => callback(error, undefined)));

const entryType = (mode: number | undefined): SftpEntry['type'] => {
  if (mode === undefined) return 'other';
  if ((mode & 0o170000) === 0o040000) return 'directory';
  if ((mode & 0o170000) === 0o120000) return 'symlink';
  if ((mode & 0o170000) === 0o100000) return 'file';
  return 'other';
};

const mapEntry = (basePath: string, entry: RawSftpEntry): SftpEntry => {
  const path = basePath === '/' ? `/${entry.filename}` : `${basePath}/${entry.filename}`;
  return {
    name: entry.filename,
    path,
    type: entryType(entry.attrs.mode),
    size: Number.isFinite(entry.attrs.size) ? Math.max(0, entry.attrs.size ?? 0) : 0,
    mode: entry.attrs.mode ?? null,
    modifiedAt: typeof entry.attrs.mtime === 'number' ? new Date(entry.attrs.mtime * 1000).toISOString() : null
  };
};

const isDirectoryEnd = (error: unknown): boolean => {
  const candidate = error as { code?: unknown; message?: unknown } | null;
  const code = candidate?.code;
  if (code === 1 || code === 'EOF' || code === 'STATUS_CODE.EOF') return true;
  return typeof candidate?.message === 'string' && /(?:eof|end of file|no more files)/iu.test(candidate.message);
};

const readDirectoryPage = async (
  resource: RawSftpResource,
  path: string,
  offset: number,
  limit: number,
  filter: string
): Promise<SftpResourceListPage> => {
  if (!resource.opendir || !resource.close) throw new AppError('SFTP_CONNECTION_FAILED');
  const handle = await callbackOperation<Buffer>((callback) => resource.opendir?.(path, callback));
  const entries: SftpEntry[] = [];
  let skipped = 0;
  let hasMore = false;
  try {
    while (!hasMore) {
      let batch: RawSftpEntry[];
      try {
        batch = await callbackOperation<RawSftpEntry[]>((callback) => resource.readdir(handle, callback));
      } catch (error) {
        if (isDirectoryEnd(error)) break;
        throw error;
      }
      if (batch.length === 0) break;
      for (const entry of batch) {
        if (entry.filename === '.' || entry.filename === '..') continue;
        if (filter && !entry.filename.toLocaleLowerCase().includes(filter)) continue;
        if (skipped < offset) {
          skipped += 1;
          continue;
        }
        if (entries.length >= limit) {
          hasMore = true;
          break;
        }
        entries.push(mapEntry(path, entry));
      }
    }
  } finally {
    await callbackVoid((callback) => resource.close?.(handle, callback));
  }
  return { entries, hasMore };
};

const writeStream = async (stream: Writable, source: AsyncIterable<Uint8Array>, onProgress?: (completedBytes: number) => void, signal?: AbortSignal, initialOffset = 0): Promise<void> => {
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    stream.destroy(new AppError('TRANSFER_CANCELLED'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let completedBytes = initialOffset;
    for await (const chunk of source) {
      if (aborted || signal?.aborted) throw new AppError('TRANSFER_CANCELLED');
      const value = Buffer.from(chunk);
      if (!stream.write(value)) await once(stream, 'drain');
      completedBytes += value.byteLength;
      onProgress?.(completedBytes);
    }
    await new Promise<void>((resolve, reject) => {
      stream.once('error', reject);
      stream.end(() => resolve());
    });
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
};

export const createSftpResource = (raw: unknown): SftpResource => {
  const resource = raw as RawSftpResource;
  return {
    list: async (path) => {
      const entries = await callbackOperation<RawSftpEntry[]>((callback) => resource.readdir(path, callback));
      return entries.map((entry) => mapEntry(path, entry));
    },
    listPage: (path, offset, limit, filter = '') => readDirectoryPage(resource, path, offset, limit, filter),
    stat: async (path) => {
      try {
        const attrs = await callbackOperation<RawSftpAttributes>((callback) => resource.stat(path, callback));
        return { name: path.split('/').at(-1) || '/', path, type: entryType(attrs.mode), size: attrs.size ?? 0, mode: attrs.mode ?? null, modifiedAt: typeof attrs.mtime === 'number' ? new Date(attrs.mtime * 1000).toISOString() : null };
      } catch (error) {
        const message = error instanceof Error ? error.message.toLowerCase() : '';
        if (message.includes('no such') || message.includes('not found')) return null;
        throw error;
      }
    },
    mkdir: (path) => callbackVoid((callback) => resource.mkdir(path, callback)),
    rename: (from, to) => callbackVoid((callback) => resource.rename(from, to, callback)),
    remove: (path) => callbackVoid((callback) => resource.unlink(path, callback)),
    rmdir: (path) => callbackVoid((callback) => resource.rmdir(path, callback)),
    writeFile: (path, source, _onProgress, signal, options?: SftpWriteOptions) => {
      const offset = options?.offset ?? 0;
      const stream = resource.createWriteStream(path, offset > 0 && options?.truncate !== true
        ? { flags: 'r+', start: offset }
        : { flags: 'w', start: 0 });
      return writeStream(stream, source, _onProgress, signal, offset);
    },
    readFile: async (path, signal, options?: SftpReadOptions) => {
      const offset = options?.offset ?? 0;
      const stream = resource.createReadStream(path, {
        start: offset,
        ...(options?.end === undefined ? {} : { end: Math.max(offset, options.end - 1) })
      });
      if (signal?.aborted) {
        stream.destroy(new AppError('TRANSFER_CANCELLED'));
        throw new AppError('TRANSFER_CANCELLED');
      }
      const onAbort = (): void => { stream.destroy(new AppError('TRANSFER_CANCELLED')); };
      signal?.addEventListener('abort', onAbort, { once: true });
      stream.once('close', () => signal?.removeEventListener('abort', onAbort));
      return stream as AsyncIterable<Uint8Array>;
    },
    close: () => resource.end?.()
  };
};

export const openSftpResource = async (connection: SshConnectionResource): Promise<SftpResource> => {
  const channel = await connection.openSftp();
  const raw = (channel as SshSftpResource & { raw?: unknown }).raw;
  if (!raw) throw new AppError('SFTP_CONNECTION_FAILED');
  const resource = createSftpResource(raw);
  const originalClose = resource.close;
  resource.close = () => {
    originalClose();
    channel.close();
  };
  return resource;
};
