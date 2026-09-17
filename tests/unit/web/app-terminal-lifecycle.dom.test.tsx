// @vitest-environment jsdom

import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMocks = vi.hoisted(() => ({
  getSetupStatus: vi.fn(),
  listGroups: vi.fn(),
  listHosts: vi.fn()
}));

const lifecycle = vi.hoisted(() => ({ mounts: 0, unmounts: 0 }));

vi.mock('../../../src/web/api', () => apiMocks);

vi.mock('../../../src/web/components/TerminalWorkspace', async () => {
  const { useEffect } = await import('react');
  return {
    TerminalWorkspace: ({ onBackToHosts }: { onBackToHosts?: () => void }) => {
      useEffect(() => {
        lifecycle.mounts += 1;
        return () => { lifecycle.unmounts += 1; };
      }, []);
      return <div data-testid="terminal-workspace"><button type="button" onClick={onBackToHosts}>返回 Server 列表</button></div>;
    }
  };
});

import { App } from '../../../src/web/App';
import { createWebAdapters } from '../../../src/web/platform/web-adapters';

const renderApp = () => render(<App runtime={createWebAdapters({ api: apiMocks })} />);

const host = {
  id: 'host-1',
  name: 'Production',
  address: 'prod.internal',
  port: 22,
  username: 'ops',
  authType: 'password' as const,
  groupId: null,
  tags: [],
  isFavorite: false,
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  lastConnectedAt: null,
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z'
};

describe('App terminal lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.mounts = 0;
    lifecycle.unmounts = 0;
    apiMocks.getSetupStatus.mockResolvedValue({ initialized: true, locked: false });
    apiMocks.listHosts.mockResolvedValue([host]);
    apiMocks.listGroups.mockResolvedValue([]);
  });

  afterEach(() => cleanup());

  it('keeps the terminal workspace mounted while switching back to Servers', async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(await screen.findByRole('button', { name: '进入 Console：Production' }));
    expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument();
    expect(lifecycle.mounts).toBe(1);

    await user.click(screen.getByRole('button', { name: '返回 Server 列表' }));

    expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument();
    expect(lifecycle.unmounts).toBe(0);
    await user.click(screen.getByRole('button', { name: '快速切换' }));
    await user.click(within(screen.getByRole('dialog', { name: '快速切换' })).getByRole('option', { name: /打开 Console/ }));
    expect(screen.getByTestId('terminal-workspace')).toBeInTheDocument();
  });
});
