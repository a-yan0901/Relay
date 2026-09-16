// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  NotificationPermission,
  NotificationPort,
  PlatformServices
} from '../../../src/shared/core/ports';

const apiMocks = vi.hoisted(() => ({
  getSetupStatus: vi.fn(),
  listGroups: vi.fn(),
  listHosts: vi.fn(),
  lockVault: vi.fn(),
  setupVault: vi.fn(),
  unlockVault: vi.fn(),
  createHost: vi.fn(),
  updateHost: vi.fn(),
  testConnection: vi.fn(),
  listAuditEvents: vi.fn(),
  getCommandRun: vi.fn(),
  getCapabilities: vi.fn(),
  getAccountSession: vi.fn(),
  register: vi.fn(),
  signIn: vi.fn(),
  signOut: vi.fn(),
  listDevices: vi.fn(),
  revokeDevice: vi.fn(),
  getSyncState: vi.fn(),
  getSyncDescriptor: vi.fn(),
  enableSync: vi.fn(),
  retrySync: vi.fn(),
  getSyncEnvelope: vi.fn(),
  pushSyncEnvelope: vi.fn(),
  previewPull: vi.fn(),
  resolveConflict: vi.fn()
}));

vi.mock('../../../src/web/api', () => apiMocks);

import { App } from '../../../src/web/App';
import { createWebAdapters } from '../../../src/web/platform/web-adapters';

const renderApp = (platformServices?: PlatformServices) => render(<App runtime={createWebAdapters({ api: apiMocks, platformServices })} />);

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
    renderApp();

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
    renderApp();

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.click(screen.getByRole('button', { name: '偏好设置' }));
    await user.selectOptions(screen.getByRole('combobox', { name: '色彩主题' }), 'light');
    await user.selectOptions(screen.getByRole('combobox', { name: '终端字号' }), '16');

    expect(document.documentElement.dataset.theme).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--terminal-font-size')).toBe('16px');
  });

  it('requests notification permission only after an explicit user action', async () => {
    const user = userEvent.setup();
    const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
    const notifications: NotificationPort = {
      permission: vi.fn(async () => 'default' as NotificationPermission),
      requestPermission,
      notify: vi.fn(async () => undefined)
    };
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    renderApp({ notifications });

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.click(screen.getByRole('button', { name: '偏好设置' }));

    expect(requestPermission).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '启用桌面通知' }));

    expect(requestPermission).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('桌面通知已启用')).toBeInTheDocument();
  });

  it('opens separate import and export flows from the Vault page', async () => {
    const user = userEvent.setup();
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    renderApp();

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.click(screen.getByRole('button', { name: '导入' }));
    expect(screen.getByRole('dialog', { name: '导入' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭导入' }));
    await user.click(screen.getByRole('button', { name: '导出' }));

    expect(screen.getByRole('dialog', { name: '导出' })).toBeInTheDocument();
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
    renderApp();

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.click(screen.getByRole('button', { name: '测试连接 Production API' }));

    expect(await screen.findByRole('status')).toHaveTextContent('连接测试成功：Production API');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('opens the unified Quick Switcher with the platform shortcut', async () => {
    const user = userEvent.setup();
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    renderApp();

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.keyboard('{Control>}k{/Control}');

    expect(screen.getByRole('dialog', { name: '快速切换' })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: '快速搜索' }));
  });

  it('keeps the header focused on task destinations', async () => {
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    renderApp();

    await screen.findByRole('heading', { name: 'Server', exact: true });
    const navigation = screen.getByRole('navigation', { name: '主导航' });
    expect(within(navigation).getByRole('button', { name: 'Server' })).toHaveAttribute('aria-current', 'page');
    expect(within(navigation).getByRole('button', { name: '工作区' })).toBeInTheDocument();
    expect(within(navigation).getByRole('button', { name: '活动' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /终端 \d+/u })).not.toBeInTheDocument();
  });

  it('moves focus into overlays and closes them with Escape', async () => {
    const user = userEvent.setup();
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    renderApp();

    await screen.findByRole('heading', { name: 'Server', exact: true });
    const quickSwitcher = screen.getByRole('button', { name: '快速切换' });
    await user.click(quickSwitcher);
    expect(document.activeElement).toBe(screen.getByRole('searchbox', { name: '快速搜索' }));
    await user.keyboard('{Escape}');
    expect(document.activeElement).toBe(quickSwitcher);

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

  it('does not open the snippet manager while editing a host', async () => {
    const user = userEvent.setup();
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    renderApp();

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.click(screen.getByRole('button', { name: '添加第一台 Server' }));
    const nameInput = screen.getByLabelText('服务器名称');
    await user.keyboard('{Control>}{Shift>}p{/Shift}{/Control}');

    expect(document.activeElement).toBe(nameInput);
    expect(screen.queryByRole('dialog', { name: '命令片段' })).not.toBeInTheDocument();
  });

  it('marks an audit link as expired when its result is no longer available', async () => {
    const user = userEvent.setup();
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    apiMocks.listAuditEvents.mockResolvedValue({ items: [{
      id: 'event-1',
      ownerId: 'owner-a',
      eventType: 'command_run_summary',
      hostId: null,
      requestId: 'request-1',
      remoteAddress: null,
      metadata: { runId: 'run-expired', targetCount: 1, successCount: 1, failureCount: 0 },
      createdAt: '2026-09-15T00:00:00.000Z'
    }] });
    apiMocks.getCommandRun.mockRejectedValue(new Error('expired'));
    renderApp();

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.click(screen.getByRole('button', { name: '活动' }));
    await user.click(await screen.findByRole('button', { name: '查看结果' }));
    await user.click(screen.getByRole('button', { name: '活动' }));

    expect(await screen.findByRole('button', { name: '结果已过期，需要重新执行' })).toBeInTheDocument();
  });

  it('announces offline recovery without hiding the workspace', async () => {
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    renderApp();

    await screen.findByRole('heading', { name: 'Server', exact: true });
    window.dispatchEvent(new Event('offline'));
    expect(await screen.findByText(/网络已断开/u)).toBeInTheDocument();

    window.dispatchEvent(new Event('online'));
    await waitFor(() => expect(screen.queryByText(/网络已断开/u)).not.toBeInTheDocument());
  });

  it('loads the optional account entry after capability negotiation without blocking the workspace', async () => {
    const user = userEvent.setup();
    const account = {
      accountId: 'account-1',
      deviceId: 'device-1',
      state: 'signed-in' as const,
      expiresAt: '2026-09-17T00:00:00.000Z'
    };
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.getCapabilities.mockResolvedValue({ client: 'web', version: 1, capabilities: ['account.auth', 'device.trust', 'sync.encrypted'] });
    apiMocks.getAccountSession.mockResolvedValue({ account: null });
    apiMocks.signIn.mockResolvedValue({ account });
    apiMocks.getSyncState.mockResolvedValue({ sync: 'local-only', head: null, pendingCount: 0 });
    apiMocks.listDevices.mockResolvedValue([]);
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    renderApp();

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.type(await screen.findByLabelText('账号邮箱'), 'user@example.com');
    await user.type(screen.getByLabelText('账号密码'), 'account-password');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(apiMocks.signIn).toHaveBeenCalledWith('user@example.com', 'account-password', undefined);
    expect(within(screen.getByRole('dialog', { name: '账号与同步' })).getByText('账号已登录')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Server', exact: true })).toBeInTheDocument();
  });

  it('passes recovery state through the app into the sync center', async () => {
    const user = userEvent.setup();
    const account = {
      accountId: 'account-1',
      deviceId: 'device-1',
      state: 'signed-in' as const,
      expiresAt: '2026-09-17T00:00:00.000Z'
    };
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.getCapabilities.mockResolvedValue({ client: 'web', version: 1, capabilities: ['account.auth', 'device.trust', 'sync.encrypted'] });
    apiMocks.getAccountSession.mockResolvedValue({ account: null });
    apiMocks.signIn.mockResolvedValue({ account });
    apiMocks.getSyncState.mockResolvedValue({
      sync: 'synced',
      head: { vaultId: 'vault-1', revision: 1, keyVersion: 1, payloadHash: 'a'.repeat(64), updatedAt: '2026-09-16T00:00:00.000Z' },
      pendingCount: 0,
      recovery: { status: 'pending-confirmation', activeKeyVersion: null, pendingKeyVersion: 1 }
    });
    apiMocks.listDevices.mockResolvedValue([]);
    apiMocks.listHosts.mockResolvedValue([]);
    apiMocks.listGroups.mockResolvedValue([]);
    renderApp();

    await screen.findByRole('heading', { name: 'Server', exact: true });
    await user.click(screen.getByRole('button', { name: '账号菜单' }));
    await user.type(await screen.findByLabelText('账号邮箱'), 'user@example.com');
    await user.type(screen.getByLabelText('账号密码'), 'account-password');
    await user.click(screen.getByRole('button', { name: '登录' }));
    await user.click(screen.getByRole('button', { name: '打开同步中心' }));

    expect(await screen.findByText(/恢复密钥待确认/u)).toBeInTheDocument();
  });
});
