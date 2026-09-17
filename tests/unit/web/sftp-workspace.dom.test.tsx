// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SftpWorkspace } from '../../../src/web/components/SftpWorkspace';
import type { SftpEntry, TransferJob } from '../../../src/shared/core/models';

const entries: SftpEntry[] = [
  { name: '.env', path: '/srv/.env', type: 'file', size: 12, mode: 0o600, modifiedAt: null },
  { name: 'releases', path: '/srv/releases', type: 'directory', size: 0, mode: 0o755, modifiedAt: null }
];

const transfer: TransferJob = {
  id: 'transfer-1', kind: 'upload', hostId: 'host-1', sourcePath: 'release.txt', targetPath: '/srv/release.txt',
  status: 'completed', completedBytes: 7, totalBytes: 7, createdAt: '', updatedAt: ''
};

describe('SftpWorkspace', () => {
  afterEach(() => cleanup());

  it('keeps Host/Workspace/path context while composing local, remote and transfer views', async () => {
    const user = userEvent.setup();
    const onRemotePathChange = vi.fn();
    const onUploadFile = vi.fn(async () => {});
    const fileTransport = {
      list: vi.fn(async (_hostId: string, _path: string) => entries),
      createDirectory: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      remove: vi.fn(async () => {})
    };
    const Wrapper = () => {
      const [path, setPath] = React.useState('/srv');
      return (
        <SftpWorkspace
          hostId="host-1"
          workspaceId="workspace-1"
          remotePath={path}
          fileTransport={fileTransport}
          transferJobs={[transfer]}
          hostAliases={{ 'host-1': 'Production' }}
          onRemotePathChange={(nextPath) => { onRemotePathChange(nextPath); setPath(nextPath); }}
          onUploadFile={onUploadFile}
        />
      );
    };

    render(<Wrapper />);

    const workspace = screen.getByRole('region', { name: 'SFTP 工作区' });
    expect(workspace).toHaveAttribute('data-workspace-id', 'workspace-1');
    expect(screen.getByRole('heading', { name: '本地文件' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: '传输中心' })).toHaveTextContent('Production');
    expect(await screen.findByRole('button', { name: '.env' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '路径 /' }));
    expect(onRemotePathChange).toHaveBeenCalledWith('/');
    expect(fileTransport.list).toHaveBeenLastCalledWith('host-1', '/');

    await user.upload(screen.getByLabelText('选择本地文件'), new File(['payload'], 'release.txt', { type: 'text/plain' }));
    expect(onUploadFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'release.txt' }), '/');
  });

  it('explains when the client cannot access local files while keeping remote SFTP available', async () => {
    const fileTransport = {
      list: vi.fn(async () => entries),
      createDirectory: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      remove: vi.fn(async () => {})
    };

    render(
      <SftpWorkspace
        hostId="host-1"
        workspaceId="workspace-1"
        remotePath="/srv"
        fileTransport={fileTransport}
        transferJobs={[]}
        localFilesEnabled={false}
        onUploadFile={vi.fn(async () => {})}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('当前客户端不支持本地文件选择');
    expect(screen.queryByLabelText('选择本地文件')).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: '.env' })).toBeInTheDocument();
  });

  it('renders every returned entry and keeps the remote pane as the scroll owner', async () => {
    const manyEntries: SftpEntry[] = Array.from({ length: 120 }, (_, index) => ({
      name: `file-${String(index).padStart(3, '0')}.log`,
      path: `/srv/file-${String(index).padStart(3, '0')}.log`,
      type: 'file',
      size: index,
      mode: 0o644,
      modifiedAt: null
    }));
    const fileTransport = {
      list: vi.fn(async () => manyEntries),
      createDirectory: vi.fn(async () => {}),
      rename: vi.fn(async () => {}),
      remove: vi.fn(async () => {})
    };

    render(
      <SftpWorkspace
        hostId="host-1"
        workspaceId="workspace-1"
        remotePath="/srv"
        fileTransport={fileTransport}
        transferJobs={[]}
        localFilesEnabled={false}
      />
    );

    expect(await screen.findByRole('button', { name: 'file-119.log' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^file-/u })).toHaveLength(120);
    expect(screen.getByRole('region', { name: '远程文件' }).parentElement).toHaveClass('sftp-remote-scroll-region');
  });
});
