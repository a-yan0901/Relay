// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CommandRun } from '../../../src/shared/core/models';
import type { HostMetadata } from '../../../src/shared/validation';
import { CommandRunResults } from '../../../src/web/components/CommandRunResults';

const hosts: HostMetadata[] = [
  {
    id: 'host-1', name: 'Production API', address: '10.0.0.8', port: 22, username: 'deploy', authType: 'password',
    groupId: null, tags: [], isFavorite: false, hostKeyAlgorithm: null, hostKeyFingerprint: null,
    lastConnectedAt: null, createdAt: '', updatedAt: ''
  },
  {
    id: 'host-2', name: 'Staging API', address: '10.0.0.9', port: 22, username: 'deploy', authType: 'password',
    groupId: null, tags: [], isFavorite: false, hostKeyAlgorithm: null, hostKeyFingerprint: null,
    lastConnectedAt: null, createdAt: '', updatedAt: ''
  },
  {
    id: 'host-3', name: 'Tools', address: '10.0.0.10', port: 22, username: 'deploy', authType: 'password',
    groupId: null, tags: [], isFavorite: false, hostKeyAlgorithm: null, hostKeyFingerprint: null,
    lastConnectedAt: null, createdAt: '', updatedAt: ''
  }
];

const run: CommandRun = {
  id: 'run-1', requestId: 'request-1', command: 'uname -a', hostIds: ['host-1', 'host-2', 'host-3'], persistOutput: false, status: 'failed',
  summary: { total: 3, queued: 0, running: 0, completed: 1, failed: 1, cancelled: 1, interrupted: 0, anomalyCount: 2, truncatedCount: 0 },
  targets: [
    { hostId: 'host-1', status: 'completed', exitCode: 0, output: 'version=1\nready', outputBytes: 15 },
    { hostId: 'host-2', status: 'failed', exitCode: 7, output: 'version=2\nready', outputBytes: 15, errorCode: 'COMMAND_RUN_TARGET_FAILED' },
    { hostId: 'host-3', status: 'cancelled', exitCode: null, output: 'cancelled output', outputBytes: 15, errorCode: 'COMMAND_RUN_CANCELLED' }
  ],
  createdAt: ''
};

describe('CommandRunResults', () => {
  afterEach(() => cleanup());

  it('filters per-host results and keeps output collapsed until the user asks for it', async () => {
    const user = userEvent.setup();
    render(<CommandRunResults run={run} hosts={hosts} />);

    expect(screen.getByText('请求 ID')).toBeInTheDocument();
    expect(screen.getByText('总计 3')).toBeInTheDocument();
    expect(screen.queryByText('version=1')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('筛选错误码'), 'COMMAND_RUN_TARGET_FAILED');
    expect(screen.getByText('Staging API')).toBeInTheDocument();
    expect(screen.queryByText('Production API')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '查看输出 Staging API' }));
    expect(screen.getByText(/version=2/u)).toBeInTheDocument();
  });

  it('shows output diff only after two hosts are explicitly selected', async () => {
    const user = userEvent.setup();
    render(<CommandRunResults run={run} hosts={hosts} />);

    await user.click(screen.getByRole('checkbox', { name: '选择对比 Production API' }));
    expect(screen.queryByRole('heading', { name: '输出 diff' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: '选择对比 Staging API' }));
    expect(screen.getByRole('heading', { name: '输出 diff' })).toBeInTheDocument();
    expect(screen.getByText(/- version=1/u)).toBeInTheDocument();
    expect(screen.getByText(/\+ version=2/u)).toBeInTheDocument();
  });

  it('paginates large result sets while keeping each output collapsed', async () => {
    const user = userEvent.setup();
    const targets = Array.from({ length: 21 }, (_, index) => ({
      hostId: `host-${index + 1}`,
      status: 'completed' as const,
      exitCode: 0,
      output: `output-${index + 1}`,
      outputBytes: 8
    }));
    render(<CommandRunResults run={{ ...run, hostIds: targets.map((target) => target.hostId), targets, summary: undefined }} hosts={[]} />);

    expect(screen.getByText('host-1')).toBeInTheDocument();
    expect(screen.queryByText('host-21')).not.toBeInTheDocument();
    expect(screen.getByText('第 1 / 2 页 · 21 条')).toBeInTheDocument();
    expect(screen.queryByText('output-1')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '下一页' }));
    expect(screen.getByText('host-21')).toBeInTheDocument();
    expect(screen.queryByText('host-1')).not.toBeInTheDocument();
  });

  it('offers an explicit jump from a result row to its host', async () => {
    const user = userEvent.setup();
    const onOpenHost = vi.fn();
    render(<CommandRunResults run={run} hosts={hosts} onOpenHost={onOpenHost} />);

    await user.click(screen.getByRole('button', { name: '打开主机 Production API' }));
    expect(onOpenHost).toHaveBeenCalledWith('host-1');
  });
});
