import type { SftpEntry } from '../../shared/core/models.js';

export interface SftpResourceListPage {
  entries: readonly SftpEntry[];
  hasMore: boolean;
}

export interface SftpWriteOptions {
  /** Byte offset in the remote file. A zero offset always truncates the file. */
  offset?: number;
  truncate?: boolean;
}

export interface SftpReadOptions {
  /** Inclusive start, exclusive end. */
  offset?: number;
  end?: number;
}

export interface SftpResource {
  list(path: string): Promise<readonly SftpEntry[]>;
  /** Optional bounded listing. Offset is a stateless cursor supplied by the service. */
  listPage?(path: string, offset: number, limit: number, filter?: string): Promise<SftpResourceListPage>;
  stat(path: string): Promise<SftpEntry | null>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  writeFile(path: string, source: AsyncIterable<Uint8Array>, onProgress?: (completedBytes: number) => void, signal?: AbortSignal, options?: SftpWriteOptions): Promise<void>;
  readFile(path: string, signal?: AbortSignal, options?: SftpReadOptions): Promise<AsyncIterable<Uint8Array>>;
  close(): void;
}

export interface SftpResourceLease {
  resource: SftpResource;
  close(): void | Promise<void>;
}
