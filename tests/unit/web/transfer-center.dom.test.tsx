// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TransferCenter } from '../../../src/web/components/TransferCenter';
import type { TransferJob } from '../../../src/shared/core/models';

const jobs: TransferJob[] = [
  {
    id: 'upload-running', kind: 'upload', hostId: 'host-prod', sourcePath: 'release.tar', targetPath: '/srv/release.tar',
    status: 'running', completedBytes: 512, totalBytes: 1024,
    checkpoint: { transferId: 'upload-running', offset: 512, totalBytes: 1024, checksum: 'a'.repeat(64) },
    createdAt: '', updatedAt: '', speedBytesPerSecond: 256, etaSeconds: 2
  },
  {
    id: 'download-failed', kind: 'download', hostId: 'host-staging', sourcePath: '/var/log/app.log', targetPath: 'app.log',
    status: 'failed', completedBytes: 128, totalBytes: 512,
    checkpoint: { transferId: 'download-failed', offset: 128, totalBytes: 512, checksum: 'b'.repeat(64) },
    errorCode: 'SFTP_PERMISSION_DENIED', createdAt: '', updatedAt: ''
  },
  {
    id: 'download-interrupted', kind: 'download', hostId: 'host-prod', sourcePath: '/var/log/worker.log', targetPath: 'worker.log',
    status: 'interrupted', completedBytes: 64, totalBytes: 128,
    checkpoint: { transferId: 'download-interrupted', offset: 64, totalBytes: 128, checksum: 'c'.repeat(64) },
    errorCode: 'SERVICE_RESTARTED', createdAt: '', updatedAt: ''
  }
];

describe('TransferCenter', () => {
  afterEach(() => cleanup());

  it('aggregates exceptions and exposes progress, checkpoint, host and safe actions', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onPause = vi.fn();
    const onRetry = vi.fn();
    const onResume = vi.fn();
    const onOpenPath = vi.fn();
    render(
      <TransferCenter
        jobs={jobs}
        hostAliases={{ 'host-prod': 'Production', 'host-staging': 'Staging' }}
        onCancel={onCancel}
        onPause={onPause}
        onRetry={onRetry}
        onResume={onResume}
        onOpenPath={onOpenPath}
      />
    );

    expect(screen.getByRole('region', { name: '传输中心' })).toHaveTextContent('1 个进行中');
    expect(screen.getByRole('region', { name: '传输中心' })).toHaveTextContent('2 个需要处理');
    expect(screen.getAllByText('Production')).not.toHaveLength(0);
    expect(screen.getByText('/srv/release.tar')).toBeInTheDocument();
    expect(screen.getByText(/50% · 256 B\/s · 预计 2s/u)).toBeInTheDocument();
    expect(screen.getByText(/断点 512 B/u)).toBeInTheDocument();
    expect(screen.getByText(/SFTP_PERMISSION_DENIED/u)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '暂停 upload-running' }));
    await user.click(screen.getByRole('button', { name: '取消 upload-running' }));
    await user.click(screen.getByRole('button', { name: '重试 download-failed' }));
    await user.click(screen.getByRole('button', { name: '继续 download-interrupted' }));
    await user.click(screen.getByRole('button', { name: '回到路径 download-failed' }));

    expect(onPause).toHaveBeenCalledWith('upload-running');
    expect(onCancel).toHaveBeenCalledWith('upload-running');
    expect(onRetry).toHaveBeenCalledWith('download-failed');
    expect(onResume).toHaveBeenCalledWith('download-interrupted');
    expect(onOpenPath).toHaveBeenCalledWith(jobs[1]);
  });

  it('keeps the empty state actionable and free of stale transfer details', () => {
    render(<TransferCenter jobs={[]} />);

    expect(screen.getByRole('region', { name: '传输中心' })).toHaveTextContent('暂无文件传输');
    expect(screen.queryByText('需要处理')).not.toBeInTheDocument();
  });

  it('exposes a paused checkpoint as resumable work', async () => {
    const user = userEvent.setup();
    const onResume = vi.fn();
    render(<TransferCenter jobs={[{
      id: 'paused-upload', kind: 'upload', hostId: 'host-prod', sourcePath: 'release.bin', targetPath: '/srv/release.bin',
      status: 'paused', completedBytes: 4, totalBytes: 10,
      checkpoint: { transferId: 'paused-upload', offset: 4, totalBytes: 10, checksum: 'd'.repeat(64) }, createdAt: '', updatedAt: ''
    }]} hostAliases={{ 'host-prod': 'Production' }} onResume={onResume} />);

    expect(screen.getByText(/已暂停，可继续/u)).toBeInTheDocument();
    expect(screen.getByText(/可从 4 B 继续/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '继续 paused-upload' }));
    expect(onResume).toHaveBeenCalledWith('paused-upload');
  });
});
