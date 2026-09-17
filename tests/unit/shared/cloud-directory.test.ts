import { describe, expect, it } from 'vitest';

import { CloudWorkspaceDirectory } from '../../../src/shared/cloud/directory.js';
import type { CloudDeviceDescriptor } from '../../../src/shared/cloud/protocol.js';
import type { CloudWorkspaceDescriptor } from '../../../src/shared/cloud/client.js';

const device = (overrides: Partial<CloudDeviceDescriptor> = {}): CloudDeviceDescriptor => ({
  id: 'device-owner',
  label: 'Windows Office',
  platform: 'desktop',
  lastSeenAt: null,
  current: false,
  revokedAt: null,
  trustedAt: '2026-09-18T00:00:00.000Z',
  ...overrides
});

const workspace = (overrides: Partial<CloudWorkspaceDescriptor> = {}): CloudWorkspaceDescriptor => ({
  id: 'workspace-1',
  accountId: 'account-1',
  ownerDeviceId: 'device-owner',
  encryptedTitle: 'opaque-title',
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z',
  deletedAt: null,
  online: true,
  activeViewerCount: 2,
  ...overrides
});

describe('bounded cloud workspace directory', () => {
  it('builds stable current, online, offline, and trust-required cards without exposing encrypted titles', async () => {
    let calls = 0;
    const api = {
      async listDevices() { calls += 1; return [device({ current: false }), device({ id: 'device-current', label: 'Current browser', platform: 'web', current: true }), device({ id: 'device-pending', label: 'Pending Android', platform: 'android', trustedAt: null })]; },
      async listWorkspaces() { calls += 1; return [workspace(), workspace({ id: 'workspace-2', ownerDeviceId: 'device-current', online: false, activeViewerCount: 0 }), workspace({ id: 'workspace-3', ownerDeviceId: 'device-pending', online: false, activeViewerCount: 0 })]; }
    };
    const directory = new CloudWorkspaceDirectory(api);

    const result = await directory.refresh('token', 'device-current');

    expect(result.cards).toEqual([
      expect.objectContaining({ workspaceId: 'workspace-2', ownerLabel: 'Current browser', status: 'current', isCurrent: true }),
      expect.objectContaining({ workspaceId: 'workspace-1', ownerLabel: 'Windows Office', status: 'online', activeViewerCount: 2, isCurrent: false }),
      expect.objectContaining({ workspaceId: 'workspace-3', status: 'needs-trust', isCurrent: false })
    ]);
    expect(result.cards[1]).not.toHaveProperty('encryptedTitle');
    expect(calls).toBe(2);
  });

  it('coalesces concurrent refreshes instead of retaining a refresh queue', async () => {
    let resolveDevices: ((value: readonly CloudDeviceDescriptor[]) => void) | undefined;
    const api = {
      listDevices: () => new Promise<readonly CloudDeviceDescriptor[]>((resolve) => { resolveDevices = resolve; }),
      async listWorkspaces() { return []; }
    };
    const directory = new CloudWorkspaceDirectory(api);
    const first = directory.refresh('token', 'device-current');
    const second = directory.refresh('token', 'device-current');
    expect(second).toBe(first);
    resolveDevices?.([]);
    await expect(first).resolves.toEqual({ devices: [], workspaces: [], cards: [] });
  });

  it('rejects directory responses above the bounded device/workspace limit', async () => {
    const api = {
      async listDevices() { return Array.from({ length: 257 }, (_, index) => device({ id: `device-${index}` })); },
      async listWorkspaces() { return []; }
    };
    await expect(new CloudWorkspaceDirectory(api).refresh('token', 'device-current')).rejects.toThrow('cloud directory response too large');
  });
});
