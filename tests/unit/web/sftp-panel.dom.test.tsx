// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SftpPanel } from '../../../src/web/components/SftpPanel';
import { TransferQueue } from '../../../src/web/components/TransferQueue';

describe('SftpPanel', () => {
  afterEach(() => cleanup());

  it('browses an independent path and requires confirmation before delete', async () => {
    const user = userEvent.setup();
    const onList = vi.fn(async () => [{ name: 'apps', path: '/apps', type: 'directory' as const, size: 0, mode: 0o755, modifiedAt: null }, { name: 'app.log', path: '/app.log', type: 'file' as const, size: 12, mode: 0o644, modifiedAt: null }]);
    const onDelete = vi.fn(async () => {});
    render(<SftpPanel hostId="host-1" onList={onList} onDelete={onDelete} />);

    expect(await screen.findByText('apps')).toBeInTheDocument();
    expect(screen.getByText('app.log')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除 app.log' }));
    expect(onDelete).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(onDelete).toHaveBeenCalledWith('/app.log');
  });

  it('wires upload and download actions to the active remote path', async () => {
    const user = userEvent.setup();
    const onList = vi.fn(async () => [{ name: 'app.log', path: '/app.log', type: 'file' as const, size: 12, mode: 0o644, modifiedAt: null }]);
    const onUpload = vi.fn(async () => {});
    const onDownload = vi.fn(async () => {});
    render(<SftpPanel hostId="host-1" onList={onList} onUpload={onUpload} onDownload={onDownload} />);

    expect(await screen.findByText('app.log')).toBeInTheDocument();
    await user.upload(screen.getByLabelText('选择上传文件'), new File(['payload'], 'release.txt', { type: 'text/plain' }));
    expect(onUpload).toHaveBeenCalledWith(expect.objectContaining({ name: 'release.txt' }), '/');
    await user.click(screen.getByRole('button', { name: '下载 app.log' }));
    expect(onDownload).toHaveBeenCalledWith('/app.log', 'app.log');
  });

  it('allows cancelling queued transfers and retrying failed ones', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onRetry = vi.fn();
    render(<TransferQueue jobs={[{
      id: 'transfer-1', kind: 'upload', hostId: 'host-1', sourcePath: 'release.txt', targetPath: '/release.txt',
      status: 'queued', completedBytes: 0, totalBytes: 7, createdAt: '', updatedAt: ''
    }, {
      id: 'transfer-2', kind: 'download', hostId: 'host-1', sourcePath: '/old.txt', targetPath: 'old.txt',
      status: 'failed', completedBytes: 0, totalBytes: null, createdAt: '', updatedAt: ''
    }]} onCancel={onCancel} onRetry={onRetry} />);

    await user.click(screen.getAllByRole('button', { name: '取消' })[0]);
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(onCancel).toHaveBeenCalledWith('transfer-1');
    expect(onRetry).toHaveBeenCalledWith('transfer-2');
  });
});
