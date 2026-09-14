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
  updateHost: vi.fn()
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
});
