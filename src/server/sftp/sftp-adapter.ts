import { once } from 'node:events';
import type { Readable, Writable } from 'node:stream';

import { AppError } from '../../shared/errors.js';
import type { SftpEntry } from '../../shared/core/models.js';
import type { SshConnectionResource, SshSftpResource } from '../ssh/types.js';
import type { SftpResource } from './types.js';

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

interface RawSftpResource {
  readdir(path: string, callback: (error: Error | undefined, entries: RawSftpEntry[]) => void): void;
  stat(path: string, callback: (error: Error | undefined, attrs: RawSftpAttributes) => void): void;
  mkdir(path: string, callback: (error: Error | undefined) => void): void;
  rename(from: string, to: string, callback: (error: Error | undefined) => void): void;
  unlink(path: string, callback: (error: Error | undefined) => void): void;
  rmdir(path: string, callback: (error: Error | undefined) => void): void;
  createReadStream(path: string): Readable;
  createWriteStream(path: string): Writable;
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

const writeStream = async (stream: Writable, source: AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<void> => {
  let aborted = false;
  const onAbort = (): void => {
    aborted = true;
    stream.destroy(new AppError('TRANSFER_CANCELLED'));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for await (const chunk of source) {
      if (aborted || signal?.aborted) throw new AppError('TRANSFER_CANCELLED');
      if (!stream.write(Buffer.from(chunk))) await once(stream, 'drain');
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
    writeFile: (path, source, _onProgress, signal) => writeStream(resource.createWriteStream(path), source, signal),
    readFile: async (path, signal) => {
      const stream = resource.createReadStream(path);
      if (signal?.aborted) {
        stream.destroy(new AppError('TRANSFER_CANCELLED'));
        throw new AppError('TRANSFER_CANCELLED');
      }
      signal?.addEventListener('abort', () => stream.destroy(new AppError('TRANSFER_CANCELLED')), { once: true });
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
