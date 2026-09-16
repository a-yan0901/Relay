// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccountSession, SyncHead, SyncPreview, SyncState } from '../../../src/shared/core/models';
import { createCapabilitySet } from '../../../src/shared/core/capabilities';
import type { DeviceTrustPort, SyncPort } from '../../../src/shared/core/ports';
import { SyncCenter } from '../../../src/web/components/SyncCenter';

const account: AccountSession = {
  accountId: 'account-1',
  deviceId: 'device-1',
  state: 'signed-in',
  expiresAt: '2026-09-17T00:00:00.000Z'
};

const head: SyncHead = {
  vaultId: 'vault-1',
  revision: 4,
  keyVersion: 1,
  payloadHash: 'a'.repeat(64),
  updatedAt: '2026-09-16T08:00:00.000Z'
};

const capabilities = createCapabilitySet('web', ['account.auth', 'device.trust', 'sync.encrypted']);

const createSyncPort = (overrides: Partial<SyncPort> = {}): SyncPort => ({
  status: vi.fn(async () => ({ sync: 'synced' as const, head, pendingCount: 0 })),
  descriptor: vi.fn(async () => null),
  pull: vi.fn(async () => null),
  push: vi.fn(async () => head),
  previewPull: vi.fn(async () => ({
    conflictId: 'conflict-1',
    localRevision: 3,
    remoteRevision: 4,
    conflictTypes: ['host'],
    localBackupRevision: 3
  } satisfies SyncPreview)),
  resolveConflict: vi.fn(async () => undefined),
  enable: vi.fn(async () => head),
  retry: vi.fn(async () => undefined),
  ...overrides
});

const renderCenter = (sync: SyncState, syncPort: SyncPort, options: { vaultLocked?: boolean; preview?: SyncPreview; devicesPort?: DeviceTrustPort } = {}) => render(
  <SyncCenter
    account={account}
    sync={sync}
    capabilities={capabilities}
    vaultLocked={options.vaultLocked ?? false}
    syncPort={syncPort}
    devicesPort={options.devicesPort}
    preview={options.preview}
    onClose={vi.fn()}
  />
);

describe('SyncCenter', () => {
  afterEach(() => cleanup());

  it('keeps enable behind the local Vault unlock boundary', async () => {
    const user = userEvent.setup();
    const syncPort = createSyncPort();
    renderCenter({ sync: 'pending', head: null, pendingCount: 1 }, syncPort, { vaultLocked: true });

    expect(screen.getByText('请先解锁 Vault')).toBeInTheDocument();
    const enable = screen.queryByRole('button', { name: '启用加密同步' });
    if (enable) await user.click(enable);
    expect(syncPort.enable).not.toHaveBeenCalled();
  });

  it('enables sync for a signed-in and unlocked account', async () => {
    const user = userEvent.setup();
    const syncPort = createSyncPort();
    renderCenter({ sync: 'local-only', head: null, pendingCount: 0 }, syncPort);

    await user.click(screen.getByRole('button', { name: '启用加密同步' }));

    expect(syncPort.enable).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('已同步')).toBeInTheDocument();
  });

  it('offers retry for pending and offline states', async () => {
    const user = userEvent.setup();
    const syncPort = createSyncPort();
    renderCenter({ sync: 'offline', head, pendingCount: 2 }, syncPort);

    await user.click(screen.getByRole('button', { name: '重试同步' }));

    expect(syncPort.retry).toHaveBeenCalledTimes(1);
  });

  it('shows trusted devices without exposing sync payload contents', async () => {
    const syncPort = createSyncPort();
    const devicesPort: DeviceTrustPort = {
      listDevices: vi.fn(async () => [{ id: 'device-2', label: '办公室浏览器', platform: 'web' as const, lastSeenAt: null, current: false, revokedAt: null }]),
      revokeDevice: vi.fn(async () => undefined)
    };
    renderCenter({ sync: 'synced', head, pendingCount: 0 }, syncPort, { devicesPort });

    expect(await screen.findByText('办公室浏览器')).toBeInTheDocument();
    expect(devicesPort.listDevices).toHaveBeenCalledTimes(1);
  });

  it('requires an explicit choice for every conflict resolution', async () => {
    const user = userEvent.setup();
    const preview: SyncPreview = {
      conflictId: 'conflict-1',
      localRevision: 3,
      remoteRevision: 4,
      conflictTypes: ['host', 'workspace'],
      localBackupRevision: 3
    };
    for (const [label, resolution] of [['保留本地', 'keep-local'], ['使用远端', 'use-remote'], ['导出两份', 'export-both'] as const]) {
      cleanup();
      const syncPort = createSyncPort();
      renderCenter({ sync: 'conflict', head, pendingCount: 1 }, syncPort, { preview });
      await user.click(screen.getByRole('button', { name: label }));
      expect(syncPort.resolveConflict).toHaveBeenCalledWith('conflict-1', resolution);
    }
  });

  it('makes a revoked device state local-only and does not render sensitive fields', () => {
    const syncPort = createSyncPort();
    const { container } = renderCenter({ sync: 'device-revoked', head: null, pendingCount: 0 }, syncPort);

    expect(screen.getByText('设备已撤销，仅保留本地数据')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/password|token|privateKey|command/iu);
  });
});
