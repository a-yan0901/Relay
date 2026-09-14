// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getSetupStatus: vi.fn(),
  listGroups: vi.fn(),
  listHosts: vi.fn(),
  lockVault: vi.fn(),
  setupVault: vi.fn(),
  unlockVault: vi.fn(),
  createHost: vi.fn(),
  updateHost: vi.fn(),
  testConnection: vi.fn()
}));

vi.mock('../../../src/web/api', () => apiMocks);

import { App } from '../../../src/web/App';

describe('App boot recovery', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => cleanup());

  it('shows a retry action when setup status cannot be loaded', async () => {
    const user = userEvent.setup();
    apiMocks.getSetupStatus
      .mockRejectedValueOnce(new Error('network unavailable'))
      .mockResolvedValueOnce({ initialized: false, locked: true });
    render(<App />);

    expect(await screen.findByRole('button', { name: '重试' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试' }));

    expect(await screen.findByRole('heading', { name: '建立你的 Server Vault' })).toBeInTheDocument();
    expect(apiMocks.getSetupStatus).toHaveBeenCalledTimes(2);
  });

  it('applies theme and font preferences from the workspace settings', async () => {
    const user = userEvent.setup();
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    render(<App />);

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.click(screen.getByRole('button', { name: '偏好设置' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '色彩主题' }), 'light');
    await user.selectOptions(screen.getByRole('combobox', { name: '终端字号' }), '16');

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--terminal-font-size')).toBe('16px');
  });

  it('announces a successful connection test as positive feedback', async () => {
    const user = userEvent.setup();
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([{
      id: 'host-1',
      name: 'Production API',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      authType: 'password',
      groupId: null,
      tags: [],
      isFavorite: false,
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyFingerprint: 'SHA256:fixture',
      lastConnectedAt: null,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z'
    }]);
    apiMocks.listGroups.mockResolvedValue([]);
    apiMocks.testConnection.mockResolvedValue({ ok: true });
    render(<App />);

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.click(screen.getByRole('button', { name: '测试连接 Production API' }));

    expect(await screen.findByRole('status')).toHaveTextContent('连接测试成功：Production API');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('focuses the active Server search with the platform shortcut', async () => {
    const user = userEvent.setup();
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    render(<App />);

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.keyboard('{Control>}k{/Control}');

    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: '搜索 Server' }));
  });

  it('moves focus into overlays and closes them with Escape', async () => {
    const user = userEvent.setup();
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    render(<App />);

    await screen.findByRole('heading', { name: 'Server', exact: true });
    const addHost = screen.getByRole('button', { name: '添加第一台 Server' });
    await user.click(addHost);
    expect(document.activeElement).toBe(screen.getByLabelText('服务器名称'));
    expect(screen.getByRole('dialog', { name: '添加 Server' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '添加 Server' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(addHost);

    await user.click(screen.getByRole('button', { name: '偏好设置' }));
    expect(document.activeElement).toBe(screen.getByRole('combobox', { name: '色彩主题' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '偏好设置' })).not.toBeInTheDocument();
  });
});
