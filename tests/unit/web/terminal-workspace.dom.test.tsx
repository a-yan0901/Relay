// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostMetadataState, TerminalTabState } from '../../../src/web/state/app-state';
import { HostKeyDialog } from '../../../src/web/components/HostKeyDialog';
import { TerminalToolbar } from '../../../src/web/components/TerminalToolbar';
import { TerminalWorkspace } from '../../../src/web/components/TerminalWorkspace';

vi.mock('../../../src/web/components/TerminalPanel', () => ({
  TerminalPanel: ({ terminalId, host, active, onClose }: { terminalId: string; host: HostMetadataState; active: boolean; onClose: () => void }) => (
    <section data-testid={`terminal-panel-${terminalId}`} hidden={!active}>
      <h2>{host.name}</h2>
      <button type="button" onClick={onClose}>关闭模拟终端</button>
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
      { terminalId: 'tab-1', hostId: 'host-1' },
      { terminalId: 'tab-2', hostId: 'host-2' }
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
    await user.click(screen.getByRole('tab', { name: '切换 Staging' }));
    expect(onActivate).toHaveBeenCalledWith('tab-2');
    expect(screen.getByTestId('terminal-panel-tab-1')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '关闭模拟终端' }));
    expect(onClose).toHaveBeenCalledWith('tab-1');
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
    render(<TerminalToolbar state="reconnecting" onReconnect={onReconnect} onClose={onClose} onClear={onClear} />);

    expect(screen.getByText('重连中')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重新连接' }));
    await user.click(screen.getByRole('button', { name: '清屏' }));
    await user.click(screen.getByRole('button', { name: '关闭终端' }));
    expect(onReconnect).toHaveBeenCalledOnce();
    expect(onClear).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });
});
