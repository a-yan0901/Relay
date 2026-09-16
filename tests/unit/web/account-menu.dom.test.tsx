// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccountDeletionState, AccountSession, SyncState } from '../../../src/shared/core/models';
import { createCapabilitySet } from '../../../src/shared/core/capabilities';
import type { AccountSessionPort, DeviceTrustPort, SyncPort } from '../../../src/shared/core/ports';
import { AccountMenu } from '../../../src/web/components/AccountMenu';

const account: AccountSession = {
  accountId: 'account-1',
  deviceId: 'device-1',
  state: 'signed-in',
  expiresAt: '2026-09-17T00:00:00.000Z'
};

const accountCapabilities = createCapabilitySet('web', ['account.auth', 'device.trust', 'sync.encrypted']);

const devices: DeviceTrustPort = {
  listDevices: vi.fn(async () => []),
  revokeDevice: vi.fn(async () => undefined)
};

describe('AccountMenu', () => {
  afterEach(() => cleanup());

  it('makes Local-only mode explicit and does not render account requests without capability', async () => {
    const user = userEvent.setup();
    const accountPort: AccountSessionPort = {
      status: vi.fn(async () => null),
      register: vi.fn(async () => account),
      signIn: vi.fn(async () => account),
      signOut: vi.fn(async () => undefined)
    };
    render(<AccountMenu capabilities={createCapabilitySet('web', [])} account={null} accountPort={accountPort} />);

    await user.click(screen.getByRole('button', { name: '账号菜单' }));

    expect(screen.getByText('仅本地，不同步')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '登录账号' })).not.toBeInTheDocument();
    expect(accountPort.status).not.toHaveBeenCalled();
    expect(accountPort.signIn).not.toHaveBeenCalled();
  });

  it('shows the server reason for a rejected sign-in without exposing the password', async () => {
    const user = userEvent.setup();
    const accountPort: AccountSessionPort = {
      status: vi.fn(async () => null),
      register: vi.fn(async () => account),
      signIn: vi.fn(async () => { throw new Error('账号或密码错误'); }),
      signOut: vi.fn(async () => undefined)
    };
    const { container } = render(<AccountMenu capabilities={accountCapabilities} account={null} accountPort={accountPort} />);

    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.type(screen.getByLabelText('账号邮箱'), 'user@example.com');
    await user.type(screen.getByLabelText('账号密码'), 'not-rendered-as-text');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('账号或密码错误');
    expect(container.textContent).not.toContain('not-rendered-as-text');
    expect(container.textContent).not.toMatch(/privateKey|passphrase|command|token/iu);
  });

  it('logs out to Local-only without invoking a Vault lock callback', async () => {
    const user = userEvent.setup();
    const onAccountChange = vi.fn();
    const accountPort: AccountSessionPort = {
      status: vi.fn(async () => account),
      register: vi.fn(async () => account),
      signIn: vi.fn(async () => account),
      signOut: vi.fn(async () => undefined)
    };
    render(<AccountMenu capabilities={accountCapabilities} account={account} accountPort={accountPort} devicesPort={devices} onAccountChange={onAccountChange} />);

    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('button', { name: '退出登录' }));

    expect(accountPort.signOut).toHaveBeenCalledTimes(1);
    expect(onAccountChange).toHaveBeenCalledWith(null);
    expect(screen.getByRole('button', { name: '账号菜单' })).toHaveTextContent('仅本地');
  });

  it('returns to sign-in mode after logging out from registration mode', async () => {
    const user = userEvent.setup();
    const accountPort: AccountSessionPort = {
      status: vi.fn(async () => null),
      register: vi.fn(async () => account),
      signIn: vi.fn(async () => account),
      signOut: vi.fn(async () => undefined)
    };
    render(<AccountMenu capabilities={accountCapabilities} accountPort={accountPort} />);

    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('button', { name: '创建新账号' }));
    await user.type(screen.getByLabelText('账号邮箱'), 'new@example.com');
    await user.type(screen.getByLabelText('账号密码'), 'long enough password');
    await user.click(screen.getByRole('button', { name: '注册' }));
    expect(screen.getByRole('dialog', { name: '账号与同步' })).toHaveTextContent('账号已登录');
    await user.click(screen.getByRole('button', { name: '退出登录' }));

    expect(screen.getByRole('button', { name: '登录' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '注册' })).not.toBeInTheDocument();
  });

  it('requires re-auth and exact confirmation before deleting the account while preserving local mode', async () => {
    const user = userEvent.setup();
    const onAccountChange = vi.fn();
    const accountPort: AccountSessionPort = {
      status: vi.fn(async () => account),
      register: vi.fn(async () => account),
      signIn: vi.fn(async () => account),
      signOut: vi.fn(async () => undefined),
      reauthenticate: vi.fn(async () => undefined),
      getDeletion: vi.fn(async () => null),
      requestDeletion: vi.fn(async () => ({ kind: 'account', requestedAt: '2026-09-17T00:00:00.000Z', deleteAfter: '2026-10-17T00:00:00.000Z', remainingMs: 2_592_000_000 } satisfies AccountDeletionState)),
      restoreDeletion: vi.fn(async () => undefined)
    };
    render(<AccountMenu capabilities={accountCapabilities} account={account} accountPort={accountPort} onAccountChange={onAccountChange} />);

    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('button', { name: '删除账号' }));
    await user.type(screen.getByLabelText('重新输入账号密码'), 'long enough password');
    await user.type(screen.getByLabelText('输入确认文本'), 'DELETE MY ACCOUNT');
    await user.click(screen.getByRole('button', { name: '确认删除账号' }));

    expect(accountPort.reauthenticate).toHaveBeenCalledWith('long enough password');
    expect(accountPort.requestDeletion).toHaveBeenCalledWith('DELETE MY ACCOUNT');
    expect(onAccountChange).toHaveBeenCalledWith(null);
    expect(screen.getByRole('button', { name: '账号菜单' })).toHaveTextContent('仅本地');
  });

  it('keeps cloud deletion separate from account deletion and updates sync state locally', async () => {
    const user = userEvent.setup();
    const onSyncChange = vi.fn();
    const cloudDeletion = { kind: 'cloud-sync' as const, requestedAt: '2026-09-17T00:00:00.000Z', deleteAfter: '2026-10-17T00:00:00.000Z', remainingMs: 2_592_000_000 };
    const accountPort: AccountSessionPort = {
      status: vi.fn(async () => account),
      register: vi.fn(async () => account),
      signIn: vi.fn(async () => account),
      signOut: vi.fn(async () => undefined),
      reauthenticate: vi.fn(async () => undefined),
      getDeletion: vi.fn(async () => null),
      requestDeletion: vi.fn(async () => ({ kind: 'account', requestedAt: '2026-09-17T00:00:00.000Z', deleteAfter: '2026-10-17T00:00:00.000Z', remainingMs: 2_592_000_000 } satisfies AccountDeletionState)),
      restoreDeletion: vi.fn(async () => undefined)
    };
    const syncPort: SyncPort = {
      status: vi.fn(async () => ({ sync: 'synced' as const, head: null, pendingCount: 0 })),
      descriptor: vi.fn(async () => null),
      pull: vi.fn(async () => null),
      push: vi.fn(async () => { throw new Error('not used'); }),
      previewPull: vi.fn(async () => { throw new Error('not used'); }),
      exportConflict: vi.fn(async () => { throw new Error('not used'); }),
      resolveConflict: vi.fn(async () => undefined),
      enable: vi.fn(async () => { throw new Error('not used'); }),
      issueRecoveryKey: vi.fn(async () => { throw new Error('not used'); }),
      confirmRecoveryKey: vi.fn(async () => { throw new Error('not used'); }),
      retry: vi.fn(async () => undefined),
      requestCloudDeletion: vi.fn(async () => cloudDeletion),
      restoreCloudDeletion: vi.fn(async () => undefined)
    };
    const sync: SyncState = { sync: 'synced', head: null, pendingCount: 0 };
    render(<AccountMenu capabilities={accountCapabilities} account={account} sync={sync} accountPort={accountPort} syncPort={syncPort} onSyncChange={onSyncChange} />);

    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('button', { name: '删除云端同步数据' }));
    await user.type(screen.getByLabelText('重新输入账号密码'), 'long enough password');
    await user.type(screen.getByLabelText('输入确认文本'), 'DELETE MY CLOUD VAULT');
    await user.click(screen.getByRole('button', { name: '确认删除云端同步数据' }));

    expect(accountPort.reauthenticate).toHaveBeenCalledWith('long enough password');
    expect(syncPort.requestCloudDeletion).toHaveBeenCalledWith('DELETE MY CLOUD VAULT');
    expect(onSyncChange).toHaveBeenCalledWith(expect.objectContaining({ sync: 'local-only', deletion: cloudDeletion }));
    expect(accountPort.requestDeletion).not.toHaveBeenCalled();
  });

  it('closes the destructive dialog with Escape and clears its inputs', async () => {
    const user = userEvent.setup();
    const accountPort: AccountSessionPort = {
      status: vi.fn(async () => account),
      register: vi.fn(async () => account),
      signIn: vi.fn(async () => account),
      signOut: vi.fn(async () => undefined),
      reauthenticate: vi.fn(async () => undefined),
      getDeletion: vi.fn(async () => null),
      requestDeletion: vi.fn(async () => ({ kind: 'account', requestedAt: '2026-09-17T00:00:00.000Z', deleteAfter: '2026-10-17T00:00:00.000Z', remainingMs: 2_592_000_000 } satisfies AccountDeletionState)),
      restoreDeletion: vi.fn(async () => undefined)
    };
    render(<AccountMenu capabilities={accountCapabilities} account={account} accountPort={accountPort} />);

    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.click(screen.getByRole('button', { name: '删除账号' }));
    await user.type(screen.getByLabelText('重新输入账号密码'), 'transient password');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog', { name: '确认删除账号' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除账号' }));
    expect(screen.getByLabelText('重新输入账号密码')).toHaveValue('');
    expect(screen.getByLabelText('输入确认文本')).toHaveValue('');
  });

  it('shows a pending account deletion countdown and lets the signed-in recovery session restore it', async () => {
    const user = userEvent.setup();
    const pending: AccountDeletionState = { kind: 'account', requestedAt: '2026-09-17T00:00:00.000Z', deleteAfter: '2026-10-17T00:00:00.000Z', remainingMs: 2_592_000_000 };
    const accountPort: AccountSessionPort = {
      status: vi.fn(async () => account),
      register: vi.fn(async () => account),
      signIn: vi.fn(async () => account),
      signOut: vi.fn(async () => undefined),
      reauthenticate: vi.fn(async () => undefined),
      getDeletion: vi.fn(async () => pending),
      requestDeletion: vi.fn(async () => pending),
      restoreDeletion: vi.fn(async () => undefined)
    };
    render(<AccountMenu capabilities={accountCapabilities} account={account} accountPort={accountPort} />);

    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    expect(await screen.findByText(/账号将在约 30 天后删除/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '恢复账号删除' }));
    await user.type(screen.getByLabelText('重新输入账号密码'), 'long enough password');
    await user.type(screen.getByLabelText('输入确认文本'), 'RESTORE ACCOUNT');
    await user.click(screen.getByRole('button', { name: '确认恢复账号删除' }));

    expect(accountPort.reauthenticate).toHaveBeenCalledWith('long enough password');
    expect(accountPort.restoreDeletion).toHaveBeenCalledTimes(1);
  });
});
