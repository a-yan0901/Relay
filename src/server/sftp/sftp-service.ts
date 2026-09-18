import { AppError } from '../../shared/errors.js';
import { normalizeSftpPath } from '../../shared/validation.js';
import type { SftpEntry, SftpListOptions, SftpListPage } from '../../shared/core/models.js';
import type { SftpResource, SftpResourceLease } from './types.js';
import { mapSftpError } from './error-mapping.js';
import type { OwnerIdProvider } from '../db/repositories.js';
import { resolveOwnerId } from '../db/repositories.js';

export interface SftpResourceProvider {
  open(hostId: string, sessionKey?: Buffer): Promise<SftpResourceLease>;
}

export interface SftpHostLookup {
  hasHost(hostId: string, ownerId: string): boolean;
}

export interface SftpServiceOptions {
  ownerId: OwnerIdProvider;
  hostLookup: SftpHostLookup;
  resourceProvider: SftpResourceProvider;
}

const sortEntries = (entries: readonly SftpEntry[]): SftpEntry[] => [...entries].sort((left, right) => {
  const leftDirectory = left.type === 'directory' ? 0 : 1;
  const rightDirectory = right.type === 'directory' ? 0 : 1;
  return leftDirectory - rightDirectory || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' });
});

const DEFAULT_LIST_LIMIT = 128;
const MAX_LIST_LIMIT = 256;
const MAX_LIST_FILTER_LENGTH = 128;

const readListOffset = (cursor: string | undefined): number => {
  if (cursor === undefined) return 0;
  if (!/^(?:0|[1-9]\d*)$/u.test(cursor) || cursor.length > 16) throw new AppError('SFTP_PATH_INVALID');
  const offset = Number(cursor);
  if (!Number.isSafeInteger(offset)) throw new AppError('SFTP_PATH_INVALID');
  return offset;
};

const readListLimit = (limit: number | undefined): number => {
  if (limit === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) throw new AppError('SFTP_PATH_INVALID');
  return limit;
};

const readListFilter = (filter: string | undefined): string => {
  if (filter === undefined) return '';
  const normalized = filter.trim();
  if (normalized.length > MAX_LIST_FILTER_LENGTH) throw new AppError('SFTP_PATH_INVALID');
  return normalized.toLocaleLowerCase();
};

const matchesFilter = (entry: SftpEntry, filter: string): boolean => filter.length === 0 || entry.name.toLocaleLowerCase().includes(filter);

export class SftpService {
  private readonly options: SftpServiceOptions;

  private get ownerId(): string { return resolveOwnerId(this.options.ownerId); }

  constructor(options: SftpServiceOptions) {
    this.options = options;
  }

  assertHost(hostId: string): void {
    if (!this.options.hostLookup.hasHost(hostId, this.ownerId)) throw new AppError('HOST_NOT_FOUND');
  }

  async listEntries(hostId: string, path: string, sessionKey?: Buffer): Promise<SftpEntry[]> {
    return this.withResource(hostId, path, (resource, normalized) => resource.list(normalized).then(sortEntries), sessionKey);
  }

  async listEntriesPage(hostId: string, path: string, options: SftpListOptions = {}, sessionKey?: Buffer): Promise<SftpListPage> {
    const offset = readListOffset(options.cursor);
    const limit = readListLimit(options.limit);
    const filter = readListFilter(options.filter);
    return this.withResource(hostId, path, async (resource, normalized) => {
      const page = await (resource.listPage
        ? resource.listPage(normalized, offset, limit, filter)
        : resource.list(normalized).then((allEntries) => {
          const matching = sortEntries(allEntries.filter((entry) => matchesFilter(entry, filter)));
          const entries = matching.slice(offset, offset + limit);
          return { entries, hasMore: offset + entries.length < matching.length };
        }));
      const entries = sortEntries(page.entries.filter((entry) => matchesFilter(entry, filter)));
      return {
        entries,
        nextCursor: page.hasMore ? String(offset + page.entries.length) : null
      };
    }, sessionKey);
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
