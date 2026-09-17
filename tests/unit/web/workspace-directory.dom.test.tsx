// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceDirectory } from '../../../src/web/components/WorkspaceDirectory';
import type { CloudWorkspaceDirectorySnapshot } from '../../../src/shared/cloud/directory';

const snapshot: CloudWorkspaceDirectorySnapshot = {
  devices: [],
  workspaces: [],
  cards: [
    { workspaceId: 'workspace-current', ownerDeviceId: 'device-current', ownerLabel: '当前浏览器', ownerPlatform: 'web', isCurrent: true, status: 'current', online: false, activeViewerCount: 0 },
    { workspaceId: 'workspace-windows', ownerDeviceId: 'device-windows', ownerLabel: '办公室 Windows', ownerPlatform: 'desktop', isCurrent: false, status: 'online', online: true, activeViewerCount: 2 },
    { workspaceId: 'workspace-offline', ownerDeviceId: 'device-phone', ownerLabel: 'Android 手机', ownerPlatform: 'android', isCurrent: false, status: 'offline-snapshot', online: false, activeViewerCount: 0 }
  ]
};

describe('workspace directory', () => {
  afterEach(() => cleanup());

  it('renders independent device workspaces and filters cards locally', async () => {
    const user = userEvent.setup();
    render(<WorkspaceDirectory snapshot={snapshot} onRefresh={vi.fn()} />);

    expect(screen.getByRole('heading', { name: '设备工作区' })).toBeInTheDocument();
    expect(screen.getByText('当前设备')).toBeInTheDocument();
    expect(screen.getByText('在线')).toBeInTheDocument();
    expect(screen.getByText('离线快照')).toBeInTheDocument();
    expect(screen.getByText('2 人在线')).toBeInTheDocument();

    await user.type(screen.getByRole('searchbox', { name: '筛选设备工作区' }), 'Android');
    expect(screen.getByText('Android 手机')).toBeInTheDocument();
    expect(screen.queryByText('办公室 Windows')).not.toBeInTheDocument();
  });

  it('does not present a fake open action before a live bridge is provided', () => {
    render(<WorkspaceDirectory snapshot={snapshot} onRefresh={vi.fn()} />);
    expect(screen.queryByRole('button', { name: '进入实时工作区' })).not.toBeInTheDocument();
    expect(screen.getByText('设备离线，仅显示状态')).toBeInTheDocument();
  });
});
