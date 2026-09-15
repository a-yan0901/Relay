// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostMetadataState, TerminalTabState } from '../../../src/web/state/app-state';
import { HostKeyDialog } from '../../../src/web/components/HostKeyDialog';
import { TerminalToolbar } from '../../../src/web/components/TerminalToolbar';
import { TerminalWorkspace } from '../../../src/web/components/TerminalWorkspace';

vi.mock('../../../src/web/components/TerminalPanel', () => ({
  TerminalPanel: ({ terminalId, host, active, onClose, onNewTerminal }: { terminalId: string; host: HostMetadataState; active: boolean; onClose: () => void; onNewTerminal?: () => void }) => (
    <section data-testid={`terminal-panel-${terminalId}`} hidden={!active}>
      <h2>{host.name}</h2>
      <button type="button" onClick={onClose}>关闭模拟终端</button>
      {onNewTerminal && <button type="button" aria-label="新建终端" onClick={onNewTerminal}>面板新建终端</button>}
    </section>
  )
}));

const host = (id: string, name: string): HostMetadataState => ({
  id,
  name,
  address: `${id}.internal`,
  port: 22,
  username: 'ops',
  authType: 'password',
  groupId: null,
  tags: [],
  isFavorite: false,
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  lastConnectedAt: null,
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z'
});

describe('TerminalWorkspace', () => {
  afterEach(() => cleanup());

  it('keeps multiple terminal panels mounted while switching active tabs', async () => {
    const user = userEvent.setup();
    const hosts = [host('host-1', 'Production'), host('host-2', 'Staging')];
    const terminals: TerminalTabState[] = [
      { terminalId: 'tab-1', hostId: 'host-1', state: 'connected', reconnectDelayMs: 0, errorMessage: null },
      { terminalId: 'tab-2', hostId: 'host-2', state: 'closed', reconnectDelayMs: 0, errorMessage: null }
    ];
    const onActivate = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalWorkspace
        hosts={hosts}
        terminals={terminals}
        activeTerminalId="tab-1"
        onActivate={onActivate}
        onClose={onClose}
      />
    );

    expect(screen.getByTestId('terminal-panel-tab-1')).toBeVisible();
    expect(screen.getByTestId('terminal-panel-tab-2')).not.toBeVisible();
    expect(screen.queryByRole('complementary', { name: '终端 Server 列表' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '切换 Staging · 1' }));
    expect(onActivate).toHaveBeenCalledWith('tab-2');
    expect(screen.getByTestId('terminal-panel-tab-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭模拟终端' }));
    expect(onClose).toHaveBeenCalledWith('tab-1');
  });

  it('opens a compact host picker from the top bar for new consoles', async () => {
    const user = userEvent.setup();
    const hosts = [host('host-1', 'Production'), host('host-2', 'Staging')];
    const terminals: TerminalTabState[] = [
      { terminalId: 'tab-1', hostId: 'host-1', state: 'connected', reconnectDelayMs: 0, errorMessage: null },
      { terminalId: 'tab-2', hostId: 'host-1', state: 'reconnecting', reconnectDelayMs: 500, errorMessage: null }
    ];
    const onConnectHost = vi.fn();
    const onClose = vi.fn();
    render(
      <TerminalWorkspace
        hosts={hosts}
        terminals={terminals}
        activeTerminalId="tab-1"
        onActivate={vi.fn()}
        onClose={onClose}
        onConnectHost={onConnectHost}
      />
    );

    expect(screen.getByRole('tab', { name: '切换 Production · 1' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '切换 Production · 2' })).toBeInTheDocument();
    expect(screen.getAllByText('重连中')).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '新建终端' }));
    expect(screen.getByRole('dialog', { name: '选择 Server' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '新建终端：Staging' }));
    expect(onConnectHost).toHaveBeenCalledWith(hosts[1]);

    await user.click(screen.getByRole('button', { name: '关闭 Production · 2' }));
    expect(onClose).toHaveBeenCalledWith('tab-2');
  });

  it('integrates workspace utilities into the terminal bar without duplicate new-console controls', async () => {
    const user = userEvent.setup();
    const onLock = vi.fn();
    const onSettings = vi.fn();
    render(
      <TerminalWorkspace
        hosts={[host('host-1', 'Production')]}
        terminals={[{ terminalId: 'tab-1', hostId: 'host-1', state: 'connected', reconnectDelayMs: 0, errorMessage: null }]}
        activeTerminalId="tab-1"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onConnectHost={vi.fn()}
        onLock={onLock}
        onSettings={onSettings}
      />
    );

    expect(screen.getByRole('button', { name: '锁定 Vault' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '偏好设置' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: '新建终端' })).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: '锁定 Vault' }));
    await user.click(screen.getByRole('button', { name: '偏好设置' }));
    expect(onLock).toHaveBeenCalledOnce();
    expect(onSettings).toHaveBeenCalledOnce();
  });

  it('splits the workspace into independently selectable console panes', async () => {
    const user = userEvent.setup();
    const hosts = [host('host-1', 'Production'), host('host-2', 'Staging'), host('host-3', 'QA')];
    const terminals: TerminalTabState[] = [
      { terminalId: 'tab-1', hostId: 'host-1', state: 'connected', reconnectDelayMs: 0, errorMessage: null },
      { terminalId: 'tab-2', hostId: 'host-2', state: 'connected', reconnectDelayMs: 0, errorMessage: null },
      { terminalId: 'tab-3', hostId: 'host-3', state: 'closed', reconnectDelayMs: 0, errorMessage: null }
    ];
    const onActivate = vi.fn();
    render(
      <TerminalWorkspace
        hosts={hosts}
        terminals={terminals}
        activeTerminalId="tab-1"
        onActivate={onActivate}
        onClose={vi.fn()}
      />
    );

    await user.click(screen.getByRole('button', { name: '左右分屏' }));
    expect(screen.getByRole('region', { name: '左侧 Console' })).toBeVisible();
    expect(screen.getByRole('region', { name: '右侧 Console' })).toBeVisible();
    const divider = screen.getByRole('separator', { name: '调整左右分屏大小' });
    expect(divider).toBeInTheDocument();
    expect(screen.getByTestId('terminal-panel-tab-1')).toBeVisible();
    expect(screen.getByTestId('terminal-panel-tab-2')).toBeVisible();

    await user.click(screen.getByRole('region', { name: '右侧 Console' }));
    expect(onActivate).toHaveBeenCalledWith('tab-2');

    divider.focus();
    await user.keyboard('{ArrowRight}');
    expect(divider).toHaveAttribute('aria-valuenow', '55');

    await user.selectOptions(screen.getByRole('combobox', { name: '右侧 Console' }), 'tab-3');
    expect(screen.getByTestId('terminal-panel-tab-3')).toBeVisible();
    expect(onActivate).toHaveBeenCalledWith('tab-3');

    await user.click(screen.getByRole('button', { name: '上下分屏' }));
    expect(screen.getByRole('separator', { name: '调整上下分屏大小' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '上下分屏' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('requires an explicit decision for a new host key', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    render(
      <HostKeyDialog
        challenge={{
          algorithm: 'ssh-ed25519',
          fingerprint: 'SHA256:fixture',
          address: '10.0.0.8',
          port: 22
        }}
        onDecision={onDecision}
      />
    );

    expect(screen.getByRole('dialog')).toHaveTextContent('SHA256:fixture');
    expect(screen.getByRole('dialog')).toHaveTextContent('10.0.0.8:22');
    await user.click(screen.getByRole('button', { name: '拒绝连接' }));
    expect(onDecision).toHaveBeenCalledWith('reject');
    await user.click(screen.getByRole('button', { name: '信任并连接' }));
    expect(onDecision).toHaveBeenCalledWith('trust');
  });

  it('exposes terminal toolbar controls for reconnect and cleanup', async () => {
    const user = userEvent.setup();
    const onReconnect = vi.fn();
    const onClose = vi.fn();
    const onClear = vi.fn();
    render(<TerminalToolbar state="reconnecting" reconnectDelayMs={1_500} onReconnect={onReconnect} onClose={onClose} onClear={onClear} />);

    expect(screen.getByText('重连中')).toBeInTheDocument();
    expect(screen.getByText('约 2 秒后自动重试')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新连接' }));
    await user.click(screen.getByRole('button', { name: '清屏' }));
    await user.click(screen.getByRole('button', { name: '关闭终端' }));
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
