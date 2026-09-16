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
});
