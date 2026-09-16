// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';

import type { HostMetadataState, TerminalTabState } from '../../../src/web/state/app-state';
import { TerminalWorkspace } from '../../../src/web/components/TerminalWorkspace';

vi.mock('../../../src/web/components/TerminalPanel', () => ({
  TerminalPanel: ({ terminalId, host, active }: { terminalId: string; host: HostMetadataState; active: boolean }) => {
    useEffect(() => undefined, []);
    return <section data-testid={`grid-panel-${terminalId}`} hidden={!active}><h2>{host.name}</h2></section>;
  }
}));

const host = (id: string): HostMetadataState => ({
  id, name: id, address: `${id}.example`, port: 22, username: 'ops', authType: 'password', groupId: null, tags: [], isFavorite: false,
  hostKeyAlgorithm: null, hostKeyFingerprint: null, lastConnectedAt: null, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z'
});

describe('TerminalWorkspace grid layout', () => {
  afterEach(() => cleanup());

  it('renders up to four visible panes and persists only workspace tab ids', async () => {
    const user = userEvent.setup();
    const terminals: TerminalTabState[] = ['1', '2', '3', '4'].map((id) => ({ terminalId: `terminal-${id}`, hostId: `host-${id}`, state: 'connected', reconnectDelayMs: 0, errorMessage: null }));
    const onLayoutChange = vi.fn();
    render(<TerminalWorkspace hosts={terminals.map((terminal) => host(terminal.hostId))} terminals={terminals} activeTerminalId="terminal-1" onActivate={vi.fn()} onClose={vi.fn()} workspaceTabIdByTerminalId={Object.fromEntries(terminals.map((terminal, index) => [terminal.terminalId, `tab-${index + 1}`]))} onLayoutChange={onLayoutChange} />);

    await user.click(screen.getByRole('button', { name: '四格布局' }));
    expect(screen.getByRole('region', { name: '第1个 Console' })).toBeVisible();
    expect(screen.getByRole('region', { name: '第4个 Console' })).toBeVisible();
    expect(screen.getAllByRole('region').filter((region) => region.getAttribute('aria-label')?.startsWith('第'))).toHaveLength(4);
    expect(onLayoutChange).toHaveBeenCalledWith({ mode: 'grid', ratio: 0.5, paneTabIds: ['tab-1', 'tab-2', 'tab-3', 'tab-4'] });
  });

  it('honors a lower negotiated pane limit and keeps overflow tabs available in the tab model', async () => {
    const user = userEvent.setup();
    const terminals: TerminalTabState[] = ['1', '2', '3', '4'].map((id) => ({ terminalId: `terminal-${id}`, hostId: `host-${id}`, state: 'connected', reconnectDelayMs: 0, errorMessage: null }));
    render(<TerminalWorkspace hosts={terminals.map((terminal) => host(terminal.hostId))} terminals={terminals} activeTerminalId="terminal-1" onActivate={vi.fn()} onClose={vi.fn()} maxPanes={2} />);

    expect(screen.queryByRole('button', { name: '四格布局' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '左右分屏' }));
    expect(screen.getAllByRole('region').filter((region) => region.getAttribute('aria-label')?.includes('Console'))).toHaveLength(2);
    expect(screen.getByRole('tab', { name: '切换 host-3 · 1' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '切换 host-4 · 1' })).toBeInTheDocument();
  });

  it('uses a negotiated three-pane grid without dropping the fourth tab', async () => {
    const user = userEvent.setup();
    const terminals: TerminalTabState[] = ['1', '2', '3', '4'].map((id) => ({ terminalId: `terminal-${id}`, hostId: `host-${id}`, state: 'connected', reconnectDelayMs: 0, errorMessage: null }));
    render(<TerminalWorkspace hosts={terminals.map((terminal) => host(terminal.hostId))} terminals={terminals} activeTerminalId="terminal-1" onActivate={vi.fn()} onClose={vi.fn()} maxPanes={3} />);

    await user.click(screen.getByRole('button', { name: '多格布局' }));
    expect(screen.getAllByRole('region').filter((region) => region.getAttribute('aria-label')?.startsWith('第'))).toHaveLength(3);
    expect(screen.getByRole('tab', { name: '切换 host-4 · 1' })).toBeInTheDocument();
  });

  it('falls back to the persisted grid order when a client can only show two panes', () => {
    const terminals: TerminalTabState[] = ['1', '2', '3', '4'].map((id) => ({ terminalId: `terminal-${id}`, hostId: `host-${id}`, state: 'connected', reconnectDelayMs: 0, errorMessage: null }));
    render(
      <TerminalWorkspace
        hosts={terminals.map((terminal) => host(terminal.hostId))}
        terminals={terminals}
        activeTerminalId="terminal-1"
        onActivate={vi.fn()}
        onClose={vi.fn()}
        maxPanes={2}
        workspaceLayout={{ mode: 'grid', ratio: 0.5, paneTabIds: ['tab-3', 'tab-2', 'tab-1', 'tab-4'] }}
        workspaceTabIdByTerminalId={{ 'terminal-1': 'tab-1', 'terminal-2': 'tab-2', 'terminal-3': 'tab-3', 'terminal-4': 'tab-4' }}
      />
    );

    expect(screen.getByRole('region', { name: '左侧 Console' })).toBeVisible();
    expect(screen.getByRole('region', { name: '右侧 Console' })).toBeVisible();
    expect(screen.getByTestId('grid-panel-terminal-3')).toBeVisible();
    expect(screen.getByTestId('grid-panel-terminal-2')).toBeVisible();
    expect(screen.getByTestId('grid-panel-terminal-1')).not.toBeVisible();
  });
});
