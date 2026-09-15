import type { SftpEntry } from '../../shared/core/models.js';

export interface SftpResource {
  list(path: string): Promise<readonly SftpEntry[]>;
  stat(path: string): Promise<SftpEntry | null>;
  mkdir(path: string, recursive?: boolean): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  remove(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  writeFile(path: string, source: AsyncIterable<Uint8Array>, onProgress?: (completedBytes: number) => void, signal?: AbortSignal): Promise<void>;
  readFile(path: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>>;
  close(): void;
}

export interface SftpResourceLease {
  resource: SftpResource;
  close(): void | Promise<void>;
}
