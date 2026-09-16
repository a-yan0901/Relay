// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/shared/errors';
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

  it('explains when an upload directory is not writable', async () => {
    const user = userEvent.setup();
    const onList = vi.fn(async () => []);
    const onUpload = vi.fn(async () => { throw new AppError('SFTP_PERMISSION_DENIED'); });
    render(<SftpPanel hostId="host-1" onList={onList} onUpload={onUpload} />);

    await screen.findByText('目录为空');
    await user.upload(screen.getByLabelText('选择上传文件'), new File(['payload'], 'release.txt', { type: 'text/plain' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('当前目录没有写权限');
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

  it('treats a transfer interrupted by service restart as retryable', async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(<TransferQueue jobs={[{
      id: 'transfer-restarted', kind: 'download', hostId: 'host-1', sourcePath: '/logs/app.log', targetPath: 'app.log',
      status: 'interrupted', completedBytes: 4, totalBytes: 10, createdAt: '', updatedAt: ''
    }]} onRetry={onRetry} />);

    expect(screen.getByText(/服务重启中断，可重试/u)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledWith('transfer-restarted');
  });

  it('shows the safe recovery position for an interrupted transfer', () => {
    render(<TransferQueue jobs={[{
      id: 'transfer-checkpoint', kind: 'upload', hostId: 'host-1', sourcePath: 'release.bin', targetPath: '/release.bin',
      status: 'interrupted', completedBytes: 4, totalBytes: 10, checkpoint: {
        transferId: 'transfer-checkpoint', offset: 4, totalBytes: 10, checksum: null
      }, createdAt: '', updatedAt: ''
    }]} onRetry={() => {}} />);

    expect(screen.getByText(/可从 4 B 继续/u)).toBeInTheDocument();
  });

  it('shows live throughput and ETA while a transfer is running', () => {
    render(<TransferQueue jobs={[{
      id: 'transfer-progress', kind: 'download', hostId: 'host-1', sourcePath: '/release.bin', targetPath: 'release.bin',
      status: 'running', completedBytes: 512, totalBytes: 2048, speedBytesPerSecond: 256, etaSeconds: 6,
      createdAt: '', updatedAt: ''
    }]} />);

    expect(screen.getByText(/25% · 256 B\/s · 预计 6s/u)).toBeInTheDocument();
  });

  it('supports breadcrumbs, directory creation and renaming without leaving the current host', async () => {
    const user = userEvent.setup();
    const onList = vi.fn(async (_hostId: string, path: string) => path === '/apps'
      ? [{ name: 'app.log', path: '/apps/app.log', type: 'file' as const, size: 12, mode: 0o644, modifiedAt: null }]
      : [{ name: 'apps', path: '/apps', type: 'directory' as const, size: 0, mode: 0o755, modifiedAt: null }]);
    const onCreateDirectory = vi.fn(async () => {});
    const onRename = vi.fn(async () => {});
    render(<SftpPanel hostId="host-1" onList={onList} onCreateDirectory={onCreateDirectory} onRename={onRename} />);

    await user.click(await screen.findByRole('button', { name: '打开目录 apps' }));
    expect(screen.getByRole('button', { name: '路径 /' })).toBeInTheDocument();
    expect(screen.getByText('apps', { selector: 'strong' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '新建目录' }));
    await user.type(screen.getByLabelText('新目录名称'), 'release');
    await user.click(screen.getByRole('button', { name: '创建目录' }));
    expect(onCreateDirectory).toHaveBeenCalledWith('/apps/release');

    await user.click(screen.getByRole('button', { name: '重命名 app.log' }));
    const renameInput = screen.getByLabelText('新名称');
    await user.clear(renameInput);
    await user.type(renameInput, 'app-current.log');
    await user.click(screen.getByRole('button', { name: '确认重命名' }));
    expect(onRename).toHaveBeenCalledWith('/apps/app.log', '/apps/app-current.log');
  });

  it('allows selecting multiple entries and confirms a batch delete', async () => {
    const user = userEvent.setup();
    const onList = vi.fn(async () => [
      { name: 'one.log', path: '/one.log', type: 'file' as const, size: 1, mode: 0o644, modifiedAt: null },
      { name: 'two.log', path: '/two.log', type: 'file' as const, size: 2, mode: 0o644, modifiedAt: null }
    ]);
    const onDelete = vi.fn(async () => {});
    render(<SftpPanel hostId="host-1" onList={onList} onDelete={onDelete} />);

    await screen.findByText('one.log');
    await user.click(screen.getByRole('checkbox', { name: '选择 one.log' }));
    await user.click(screen.getByRole('checkbox', { name: '选择 two.log' }));
    expect(screen.getByText('已选择 2 项')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '删除选中' }));
    expect(screen.getByText('删除 2 个远程项目？')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(onDelete).toHaveBeenCalledWith('/one.log');
    expect(onDelete).toHaveBeenCalledWith('/two.log');
  });

  it('uses the supplied Host path context when the active Host changes', async () => {
    const onList = vi.fn(async (_hostId: string, path: string) => [{ name: path.slice(1) || 'root', path, type: 'file' as const, size: 1, mode: 0o644, modifiedAt: null }]);
    const { rerender } = render(<SftpPanel hostId="host-1" remotePath="/prod" onList={onList} />);

    expect(await screen.findByText('prod')).toBeInTheDocument();
    rerender(<SftpPanel hostId="host-2" remotePath="/staging" onList={onList} />);

    expect(await screen.findByText('staging')).toBeInTheDocument();
    expect(onList).toHaveBeenLastCalledWith('host-2', '/staging');
  });
});
