// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@shared/errors';
import type { AccountSession, VaultRecoveryPreview } from '../../../src/shared/core/models';
import type { VaultRecoveryInput, VaultRecoveryPort } from '../../../src/shared/core/ports';
import { SyncRecoveryView } from '../../../src/web/components/SyncRecoveryView';

const account: AccountSession = {
  accountId: 'account-1',
  deviceId: 'device-1',
  state: 'signed-in',
  expiresAt: '2026-10-17T00:00:00.000Z'
};

const preview: VaultRecoveryPreview = {
  previewId: 'preview-1',
  vaultId: 'vault-1',
  revision: 3,
  payloadHash: 'a'.repeat(64),
  hostCount: 2,
  groupCount: 1,
  identityCount: 1,
  snippetCount: 4,
  workspaceIncluded: true,
  conflictTypes: [],
  expiresAt: '2026-09-17T00:05:00.000Z'
};

const recoveryPort = (overrides: Partial<VaultRecoveryPort> = {}): VaultRecoveryPort => ({
  preview: vi.fn(async (_input: VaultRecoveryInput) => preview),
  apply: vi.fn(async () => ({ phase: 'unlocked' as const })),
  ...overrides
});

describe('SyncRecoveryView', () => {
  afterEach(() => cleanup());

  it('requires an account before requesting recovery data', async () => {
    const user = userEvent.setup();
    const port = recoveryPort();
    render(<SyncRecoveryView account={null} recoveryPort={port} onRecovered={vi.fn(async () => undefined)} onBack={vi.fn()} />);

    expect(screen.getByText('请先登录账号，再恢复云端 Vault')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '预览恢复内容' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '返回主密码解锁' }));
    expect(port.preview).not.toHaveBeenCalled();
  });

  it('previews the selected unlock method before enabling local Vault creation', async () => {
    const user = userEvent.setup();
    const onRecovered = vi.fn(async () => undefined);
    const port = recoveryPort();
    render(<SyncRecoveryView account={account} recoveryPort={port} onRecovered={onRecovered} onBack={vi.fn()} />);

    const secret = screen.getByLabelText('恢复密钥或原 Vault 主密码');
    await user.type(secret, 'recovery-secret');
    const apply = screen.queryByRole('button', { name: '创建本地 Vault 并应用' });
    expect(apply).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '预览恢复内容' }));

    expect(await screen.findByText(/将恢复 2 台 Server、1 个分组、1 个身份和 4 个片段/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '创建本地 Vault 并应用' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: '创建本地 Vault 并应用' }));

    expect(port.preview).toHaveBeenCalledWith({ method: 'recovery-key', secret: 'recovery-secret' });
    expect(port.apply).toHaveBeenCalledWith('preview-1', { method: 'recovery-key', secret: 'recovery-secret' });
    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(secret).toHaveValue('');
  });

  it('shows retryable input errors and never applies without a fresh preview', async () => {
    const user = userEvent.setup();
    const port = recoveryPort({
      preview: vi.fn(async () => { throw new AppError('VAULT_UNLOCK_FAILED'); })
    });
    render(<SyncRecoveryView account={account} recoveryPort={port} onRecovered={vi.fn(async () => undefined)} onBack={vi.fn()} />);

    await user.type(screen.getByLabelText('恢复密钥或原 Vault 主密码'), 'wrong-secret');
    await user.click(screen.getByRole('button', { name: '预览恢复内容' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('主密码错误或 Vault 已损坏');
    expect(screen.queryByRole('button', { name: '创建本地 Vault 并应用' })).not.toBeInTheDocument();
  });

  it('clears an expired preview so the user must preview again', async () => {
    const user = userEvent.setup();
    const port = recoveryPort({
      apply: vi.fn(async () => { throw new AppError('SYNC_NOT_FOUND'); })
    });
    render(<SyncRecoveryView account={account} recoveryPort={port} onRecovered={vi.fn(async () => undefined)} onBack={vi.fn()} />);

    await user.type(screen.getByLabelText('恢复密钥或原 Vault 主密码'), 'recovery-secret');
    await user.click(screen.getByRole('button', { name: '预览恢复内容' }));
    await user.click(screen.getByRole('button', { name: '创建本地 Vault 并应用' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('同步数据不存在或已过期');
    expect(screen.queryByRole('button', { name: '创建本地 Vault 并应用' })).not.toBeInTheDocument();
  });
});
