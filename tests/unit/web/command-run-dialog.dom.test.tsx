// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostMetadata } from '../../../src/shared/validation';
import { CommandRunDialog } from '../../../src/web/components/CommandRunDialog';

const hosts: HostMetadata[] = [
  {
    id: 'host-1', name: 'Production API', address: '10.0.0.8', port: 22, username: 'deploy', authType: 'password',
    groupId: null, tags: ['prod'], isFavorite: true, hostKeyAlgorithm: null, hostKeyFingerprint: null,
    lastConnectedAt: null, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z'
  },
  {
    id: 'host-2', name: 'Staging API', address: '10.0.0.9', port: 22, username: 'deploy', authType: 'password',
    groupId: null, tags: ['staging'], isFavorite: false, hostKeyAlgorithm: null, hostKeyFingerprint: null,
    lastConnectedAt: null, createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z'
  }
];

describe('CommandRunDialog', () => {
  afterEach(() => cleanup());

  it('shows the complete target and command preview before the final confirmation', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<CommandRunDialog hosts={hosts} hostIds={['host-1', 'host-2']} initialCommand="systemctl status {{service}}" initialVariables={{ service: 'api' }} onConfirm={onConfirm} onClose={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '批量执行' })).toBeInTheDocument();
    expect(screen.getByText('Production API · 10.0.0.8')).toBeInTheDocument();
    expect(screen.getByText('Staging API · 10.0.0.9')).toBeInTheDocument();
    expect(screen.getByText('systemctl status api')).toBeInTheDocument();
    expect(screen.getByText('并发 4')).toBeInTheDocument();
    expect(screen.getByText('超时 60 秒')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '确认执行' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '确认执行' }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      command: 'systemctl status {{service}}', hostIds: ['host-1', 'host-2'], variables: { service: 'api' }, confirmed: true,
      targetSelection: expect.objectContaining({ source: 'servers', hostIds: ['host-1', 'host-2'], displayNames: ['Production API', 'Staging API'] })
    }));
  });

  it('deduplicates repeated terminal tabs before confirming a batch run', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(<CommandRunDialog hosts={hosts} hostIds={['host-1', 'host-1']} initialCommand="ls" onConfirm={onConfirm} onClose={vi.fn()} />);

    expect(screen.getAllByText('Production API · 10.0.0.8')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: '确认执行' }));

    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      command: 'ls', hostIds: ['host-1'], confirmed: true
    }));
  });
});
