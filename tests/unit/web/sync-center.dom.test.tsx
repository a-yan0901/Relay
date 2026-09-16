// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

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
  issueRecoveryKey: vi.fn(async (reveal) => {
    reveal('RLY-RK1-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA', 1);
    return { status: 'pending-confirmation' as const, activeKeyVersion: null, pendingKeyVersion: 1 };
  }),
  confirmRecoveryKey: vi.fn(async () => ({ status: 'configured' as const, activeKeyVersion: 1, pendingKeyVersion: null })),
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

  it('requires offline save and matching recovery key before confirming', async () => {
    const user = userEvent.setup();
    const syncPort = createSyncPort();
    renderCenter({ sync: 'synced', head, pendingCount: 0, recovery: { status: 'not-configured', activeKeyVersion: null, pendingKeyVersion: null } }, syncPort);

    await user.click(screen.getByRole('button', { name: '生成恢复密钥' }));
    expect(screen.getByText(/RLY-RK1-/u)).toBeInTheDocument();
    const confirm = screen.getByRole('button', { name: '确认已离线保存' });
    expect(confirm).toBeDisabled();

    await user.click(screen.getByRole('checkbox', { name: '我已离线保存恢复密钥' }));
    await user.type(screen.getByRole('textbox', { name: '再次输入恢复密钥' }), 'RLY-RK1-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA');
    expect(confirm).toBeEnabled();
    await user.click(confirm);

    expect(syncPort.confirmRecoveryKey).toHaveBeenCalledWith('RLY-RK1-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA-AAAA');
    expect(await screen.findByText('恢复密钥已配置')).toBeInTheDocument();
  });

  it('offers recovery key rotation after the current key is configured', async () => {
    const user = userEvent.setup();
    const syncPort = createSyncPort();
    renderCenter({ sync: 'synced', head, pendingCount: 0, recovery: { status: 'configured', activeKeyVersion: 1, pendingKeyVersion: null } }, syncPort);

    await user.click(screen.getByRole('button', { name: '轮换恢复密钥' }));

    expect(syncPort.issueRecoveryKey).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('请离线保存新的恢复密钥')).toBeInTheDocument();
  });

  it('keeps a newly issued key visible when the parent accepts the sync state update', async () => {
    const user = userEvent.setup();
    const syncPort = createSyncPort();
    const StatefulCenter = () => {
      const [currentSync, setCurrentSync] = useState<SyncState>({ sync: 'synced', head, pendingCount: 0, recovery: { status: 'not-configured', activeKeyVersion: null, pendingKeyVersion: null } });
      return <SyncCenter account={account} sync={currentSync} capabilities={capabilities} vaultLocked={false} syncPort={syncPort} onSyncChange={setCurrentSync} onClose={vi.fn()} />;
    };
    render(<StatefulCenter />);

    await user.click(screen.getByRole('button', { name: '生成恢复密钥' }));

    expect(await screen.findByText(/RLY-RK1-/u)).toBeInTheDocument();
  });

  it('does not redisplay a pending recovery key after the center is reopened', () => {
    const syncPort = createSyncPort();
    renderCenter({ sync: 'synced', head, pendingCount: 0, recovery: { status: 'pending-confirmation', activeKeyVersion: null, pendingKeyVersion: 1 } }, syncPort);

    expect(screen.getByText('恢复密钥待确认')).toBeInTheDocument();
    expect(screen.queryByText(/RLY-RK1-/u)).not.toBeInTheDocument();
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
