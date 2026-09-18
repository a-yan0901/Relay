import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import { SftpService, type SftpResourceProvider } from '../../../src/server/sftp/sftp-service.js';
import type { SftpResource } from '../../../src/server/sftp/types.js';

const entries = [
  { name: 'z.log', path: '/z.log', type: 'file' as const, size: 2, mode: 0o644, modifiedAt: null },
  { name: 'apps', path: '/apps', type: 'directory' as const, size: 0, mode: 0o755, modifiedAt: null },
  { name: 'alpha', path: '/alpha', type: 'file' as const, size: 1, mode: 0o600, modifiedAt: null }
];

const resource = (): SftpResource & { listCalls: string[]; removed: string[] } => ({
  listCalls: [],
  removed: [],
  async list(path) { this.listCalls.push(path); return entries; },
  async stat(path) { return entries.find((entry) => entry.path === path) ?? null; },
  async mkdir() {},
  async rename() {},
  async remove(path) { this.removed.push(path); },
  async rmdir(path) { this.removed.push(path); },
  async writeFile() {},
  async readFile() { return (async function* () {})(); },
  close() {}
});

const createService = (nextResource: SftpResource, hostId = 'host-1'): { service: SftpService; provider: SftpResourceProvider } => {
  const provider: SftpResourceProvider = { open: vi.fn(async (requestedHostId) => {
    if (requestedHostId !== hostId) throw new AppError('HOST_NOT_FOUND');
    return { resource: nextResource, close: () => nextResource.close() };
  }) };
  return {
    provider,
    service: new SftpService({
      ownerId: 'owner-a',
      hostLookup: { hasHost: (requestedHostId, ownerId) => requestedHostId === hostId && ownerId === 'owner-a' },
      resourceProvider: provider
    })
  };
};

describe('SftpService', () => {
  it('normalizes paths and sorts directories before files without receiving credentials', async () => {
    const nextResource = resource();
    const { service: sftpService, provider } = createService(nextResource);
    const listed = await sftpService.listEntries('host-1', '//');

    expect(nextResource.listCalls).toEqual(['/']);
    expect(listed.map((entry) => entry.name)).toEqual(['apps', 'alpha', 'z.log']);
    expect(provider.open).toHaveBeenCalledWith('host-1');
    expect(JSON.stringify(provider.open.mock.calls)).not.toContain('password');
  });

  it('maps missing hosts, invalid paths, and delete confirmation to stable errors', async () => {
    const { service: sftpService } = createService(resource());
    await expect(sftpService.listEntries('unknown', '/')).rejects.toMatchObject({ code: 'HOST_NOT_FOUND' });
    await expect(sftpService.listEntries('host-1', '/../../etc')).rejects.toMatchObject({ code: 'SFTP_PATH_INVALID' });
    await expect(sftpService.removeEntry('host-1', '/alpha', false)).rejects.toMatchObject({ code: 'SFTP_PERMISSION_DENIED' });
  });

  it('exposes narrow entry operations and releases the resource', async () => {
    const nextResource = resource();
    const close = vi.spyOn(nextResource, 'close');
    const { service: sftpService } = createService(nextResource);
    await sftpService.createDirectory('host-1', '/new-dir');
    await sftpService.renameEntry('host-1', '/alpha', '/renamed');
    await sftpService.removeEntry('host-1', '/alpha', true);
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('returns bounded directory pages without changing the legacy sorted listing', async () => {
    const { service: sftpService } = createService(resource());

    const first = await sftpService.listEntriesPage('host-1', '/', { limit: 2 });
    expect(first.entries.map((entry) => entry.name)).toEqual(['apps', 'alpha']);
    expect(first.nextCursor).toBe('2');

    const second = await sftpService.listEntriesPage('host-1', '/', { cursor: first.nextCursor ?? undefined, limit: 2 });
    expect(second.entries.map((entry) => entry.name)).toEqual(['z.log']);
    expect(second.nextCursor).toBeNull();
  });

  it('applies the bounded name filter before slicing a page', async () => {
    const { service: sftpService } = createService(resource());
    const page = await sftpService.listEntriesPage('host-1', '/', { filter: 'A', limit: 1 });

    expect(page.entries.map((entry) => entry.name)).toEqual(['apps']);
    expect(page.nextCursor).toBe('1');
  });
});
