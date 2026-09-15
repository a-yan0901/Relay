import { AppError } from '../../shared/errors.js';
import { normalizeSftpPath } from '../../shared/validation.js';
import type { SftpEntry } from '../../shared/core/models.js';
import type { SftpResource, SftpResourceLease } from './types.js';

export interface SftpResourceProvider {
  open(hostId: string, sessionKey?: Buffer): Promise<SftpResourceLease>;
}

export interface SftpHostLookup {
  hasHost(hostId: string, ownerId: string): boolean;
}

export interface SftpServiceOptions {
  ownerId: string;
  hostLookup: SftpHostLookup;
  resourceProvider: SftpResourceProvider;
}

const mapSftpError = (error: unknown): AppError => {
  if (error instanceof AppError) return error;
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('no such') || message.includes('not found') || message.includes('enoent')) return new AppError('SFTP_NOT_FOUND');
  if (message.includes('permission') || message.includes('denied') || message.includes('eacces')) return new AppError('SFTP_PERMISSION_DENIED');
  return new AppError('SFTP_TRANSFER_FAILED');
};

const sortEntries = (entries: readonly SftpEntry[]): SftpEntry[] => [...entries].sort((left, right) => {
  const leftDirectory = left.type === 'directory' ? 0 : 1;
  const rightDirectory = right.type === 'directory' ? 0 : 1;
  return leftDirectory - rightDirectory || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
});

export class SftpService {
  private readonly options: SftpServiceOptions;

  constructor(options: SftpServiceOptions) {
    this.options = options;
  }

  assertHost(hostId: string): void {
    if (!this.options.hostLookup.hasHost(hostId, this.options.ownerId)) throw new AppError('HOST_NOT_FOUND');
  }

  async listEntries(hostId: string, path: string, sessionKey?: Buffer): Promise<SftpEntry[]> {
    return this.withResource(hostId, path, (resource, normalized) => resource.list(normalized).then(sortEntries), sessionKey);
  }

  async statEntry(hostId: string, path: string, sessionKey?: Buffer): Promise<SftpEntry | null> {
    return this.withResource(hostId, path, (resource, normalized) => resource.stat(normalized), sessionKey);
  }

  async createDirectory(hostId: string, path: string, sessionKey?: Buffer): Promise<void> {
    await this.withResource(hostId, path, (resource, normalized) => resource.mkdir(normalized, false), sessionKey);
  }

  async renameEntry(hostId: string, from: string, to: string, sessionKey?: Buffer): Promise<void> {
    const normalizedFrom = this.validatePath(from);
    const normalizedTo = this.validatePath(to);
    await this.withResource(hostId, normalizedFrom, (resource) => resource.rename(normalizedFrom, normalizedTo), sessionKey);
  }

  async removeEntry(hostId: string, path: string, confirmed: boolean, sessionKey?: Buffer): Promise<void> {
    if (!confirmed) throw new AppError('SFTP_PERMISSION_DENIED', '删除远程文件前需要确认', 400);
    await this.withResource(hostId, path, async (resource, normalized) => {
      const entry = await resource.stat(normalized);
      if (entry?.type === 'directory') await resource.rmdir(normalized);
      else await resource.remove(normalized);
    }, sessionKey);
  }

  private validatePath(path: string): string {
    return normalizeSftpPath(path);
  }

  private async withResource<T>(hostId: string, path: string, operation: (resource: SftpResource, normalizedPath: string) => Promise<T>, sessionKey?: Buffer): Promise<T> {
    this.assertHost(hostId);
    const normalizedPath = this.validatePath(path);
    const lease = sessionKey === undefined
      ? await this.options.resourceProvider.open(hostId)
      : await this.options.resourceProvider.open(hostId, sessionKey);
    try {
      return await operation(lease.resource, normalizedPath);
    } catch (error) {
      throw mapSftpError(error);
    } finally {
      await lease.close();
    }
  }
}
