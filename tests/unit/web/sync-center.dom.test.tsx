// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';

import { AppError } from '../../../src/shared/errors';
import type { AccountSession, SyncConflictExport, SyncHead, SyncPreview, SyncState } from '../../../src/shared/core/models';
import { createCapabilitySet } from '../../../src/shared/core/capabilities';
import type { DeviceTrustPort, FileSavePort, SyncPort } from '../../../src/shared/core/ports';
import { parseSyncConflictExport } from '../../../src/shared/core/sync-conflict-export';
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

const createConflictExport = (): SyncConflictExport => {
  const envelope = (aad: string) => ({
    version: 1 as const,
    nonce: Buffer.alloc(12).toString('base64'),
    ciphertext: Buffer.alloc(32).toString('base64'),
    authTag: Buffer.alloc(16).toString('base64'),
    aad: Buffer.from(aad).toString('base64')
  });
  const localAad = 'relay-sync-conflict:v1:conflict-1:local';
  const remoteAad = 'relay-sync-conflict:v1:conflict-1:remote';
  return {
    format: 'relay-sync-conflict',
    version: 1,
    conflictId: 'conflict-1',
    createdAt: '2026-09-17T10:00:00.000Z',
    copies: [
      { copy: 'local', revision: 3, payloadHash: 'a'.repeat(64), kdf: { algorithm: 'argon2id', memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32, salt: Buffer.alloc(16).toString('base64') }, wrappedBundleKey: envelope(localAad), payload: envelope(localAad) },
      { copy: 'remote', revision: 4, payloadHash: 'b'.repeat(64), kdf: { algorithm: 'argon2id', memoryCost: 19_456, timeCost: 2, parallelism: 1, hashLength: 32, salt: Buffer.alloc(16, 1).toString('base64') }, wrappedBundleKey: envelope(remoteAad), payload: envelope(remoteAad) }
    ]
  };
};

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
  exportConflict: vi.fn(async () => createConflictExport()),
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

const renderCenter = (sync: SyncState, syncPort: SyncPort, options: { vaultLocked?: boolean; preview?: SyncPreview; devicesPort?: DeviceTrustPort; fileSave?: FileSavePort } = {}) => render(
  <SyncCenter
    account={account}
    sync={sync}
    capabilities={capabilities}
    vaultLocked={options.vaultLocked ?? false}
    syncPort={syncPort}
    devicesPort={options.devicesPort}
    fileSave={options.fileSave}
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
    for (const [label, resolution] of [['保留本地', 'keep-local'], ['使用远端', 'use-remote'] as const]) {
      cleanup();
      const syncPort = createSyncPort();
      renderCenter({ sync: 'conflict', head, pendingCount: 1 }, syncPort, { preview });
      await user.click(screen.getByRole('button', { name: label }));
      expect(syncPort.resolveConflict).toHaveBeenCalledWith('conflict-1', resolution);
    }
  });

  it('exports an encrypted copy with matching password confirmation and keeps the conflict open', async () => {
    const user = userEvent.setup();
    let saved: { name: string; content: Uint8Array; mimeType: string } | undefined;
    const fileSave: FileSavePort = {
      save: vi.fn(async (request) => { saved = request; })
    };
    const syncPort = createSyncPort();
    const preview: SyncPreview = { conflictId: 'conflict-1', localRevision: 3, remoteRevision: 4, conflictTypes: ['host', 'workspace'], localBackupRevision: 3 };
    renderCenter({ sync: 'conflict', head, pendingCount: 1 }, syncPort, { preview, fileSave });

    await user.click(screen.getByRole('button', { name: '导出两份' }));
    const exportDialog = screen.getByRole('dialog', { name: '导出加密副本' });
    expect(exportDialog).toBeInTheDocument();
    const submit = screen.getByRole('button', { name: '下载加密副本' });
    expect(submit).toBeDisabled();

    await user.type(screen.getByLabelText('导出密码'), 'short');
    await user.type(screen.getByLabelText('确认导出密码'), 'short');
    await user.click(submit);
    expect(await screen.findByRole('alert')).toHaveTextContent('至少需要 8 个字符');
    expect(syncPort.exportConflict).not.toHaveBeenCalled();

    await user.clear(screen.getByLabelText('导出密码'));
    await user.clear(screen.getByLabelText('确认导出密码'));
    await user.type(screen.getByLabelText('导出密码'), 'one-time export password');
    await user.type(screen.getByLabelText('确认导出密码'), 'one-time export password');
    expect(submit).toBeEnabled();
    await user.click(submit);

    expect(syncPort.exportConflict).toHaveBeenCalledWith('conflict-1', 'one-time export password');
    expect(fileSave.save).toHaveBeenCalledTimes(1);
    expect(saved?.name).toBe('relay-sync-conflict-conflict-1.json');
    expect(saved?.mimeType).toBe('application/json;charset=utf-8');
    expect(parseSyncConflictExport(JSON.parse(new TextDecoder().decode(saved?.content)))).toEqual(createConflictExport());
    expect(screen.getByText('需要你选择冲突处理方式')).toBeInTheDocument();
    expect(screen.queryByLabelText('导出密码')).not.toBeInTheDocument();
    expect(syncPort.resolveConflict).not.toHaveBeenCalled();
  });

  it('clears entered passwords after a failed export and allows retry', async () => {
    const user = userEvent.setup();
    const syncPort = createSyncPort({ exportConflict: vi.fn(async () => { throw new Error('export failed'); }) });
    const fileSave: FileSavePort = { save: vi.fn(async () => undefined) };
    renderCenter({ sync: 'conflict', head, pendingCount: 1 }, syncPort, { preview: { conflictId: 'conflict-1', localRevision: 3, remoteRevision: 4, conflictTypes: ['host'], localBackupRevision: 3 }, fileSave });

    await user.click(screen.getByRole('button', { name: '导出两份' }));
    await user.type(screen.getByLabelText('导出密码'), 'one-time export password');
    await user.type(screen.getByLabelText('确认导出密码'), 'one-time export password');
    await user.click(screen.getByRole('button', { name: '下载加密副本' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('export failed');
    expect(screen.getByLabelText('导出密码')).toHaveValue('');
    expect(screen.getByLabelText('确认导出密码')).toHaveValue('');
  });

  it('closes a stale export form and reloads the conflict preview', async () => {
    const user = userEvent.setup();
    const syncPort = createSyncPort({ exportConflict: vi.fn(async () => { throw new AppError('SYNC_NOT_FOUND'); }) });
    const fileSave: FileSavePort = { save: vi.fn(async () => undefined) };
    renderCenter({ sync: 'conflict', head, pendingCount: 1 }, syncPort, { preview: { conflictId: 'conflict-1', localRevision: 3, remoteRevision: 4, conflictTypes: ['host'], localBackupRevision: 3 }, fileSave });

    await user.click(screen.getByRole('button', { name: '导出两份' }));
    await user.type(screen.getByLabelText('导出密码'), 'one-time export password');
    await user.type(screen.getByLabelText('确认导出密码'), 'one-time export password');
    await user.click(screen.getByRole('button', { name: '下载加密副本' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('冲突状态已变化，请重新加载');
    expect(screen.queryByRole('dialog', { name: '导出加密副本' })).not.toBeInTheDocument();
    expect(await screen.findByText('需要你选择冲突处理方式')).toBeInTheDocument();
    expect(syncPort.previewPull).toHaveBeenCalledTimes(1);
    expect(syncPort.resolveConflict).not.toHaveBeenCalled();
  });

  it('makes a revoked device state local-only and does not render sensitive fields', () => {
    const syncPort = createSyncPort();
    const { container } = renderCenter({ sync: 'device-revoked', head: null, pendingCount: 0 }, syncPort);

    expect(screen.getByText('设备已撤销，仅保留本地数据')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/password|token|privateKey|command/iu);
  });
});
