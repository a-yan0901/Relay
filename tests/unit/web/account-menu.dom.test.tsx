// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AccountSession } from '../../../src/shared/core/models';
import { createCapabilitySet } from '../../../src/shared/core/capabilities';
import type { AccountSessionPort, DeviceTrustPort } from '../../../src/shared/core/ports';
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
});
