// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostCard } from '../../../src/web/components/HostCard';
import type { HostMetadataState } from '../../../src/web/state/app-state';

const host: HostMetadataState = {
  id: 'host-1',
  name: 'Production API',
  address: '10.0.0.8',
  port: 22,
  username: 'deploy',
  authType: 'password',
  groupId: null,
  tags: ['prod'],
  isFavorite: false,
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  lastConnectedAt: '2026-09-14T08:00:00.000Z',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z'
};

describe('HostCard', () => {
  afterEach(() => cleanup());

  it('exposes connection management actions and recent connection metadata', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    const onTestConnection = vi.fn();
    const onConnect = vi.fn();
    render(
      <HostCard
        host={host}
        onConnect={onConnect}
        onFavoriteToggle={vi.fn()}
        onEdit={onEdit}
        onDelete={onDelete}
        onTestConnection={onTestConnection}
      />
    );

    expect(screen.getByText(/最近连接/iu)).toBeInTheDocument();
    expect(screen.getByText('等待首次验证')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '删除 Production API' })).toHaveTextContent('删除');
    await user.click(screen.getByRole('button', { name: '进入 Console：Production API' }));
    await user.click(screen.getByRole('button', { name: '编辑 Production API' }));
    await user.click(screen.getByRole('button', { name: '测试连接 Production API' }));
    await user.click(screen.getByRole('button', { name: '删除 Production API' }));

    expect(onConnect).toHaveBeenCalledWith(host);
    expect(onEdit).toHaveBeenCalledWith(host);
    expect(onTestConnection).toHaveBeenCalledWith(host);
    expect(onDelete).toHaveBeenCalledWith(host);
  });

  it('shows trusted Host Key details and exposes an explicit clear-trust action', async () => {
    const user = userEvent.setup();
    const onClearHostKey = vi.fn();
    const trustedHost = {
      ...host,
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyFingerprint: 'SHA256:fixture',
      credentialSource: { type: 'identity' as const, identityId: 'identity-1' },
      identityName: 'Production deploy',
      identitySource: 'host' as const
    };
    render(<HostCard host={trustedHost} groupName="Production" onConnect={vi.fn()} onFavoriteToggle={vi.fn()} onClearHostKey={onClearHostKey} />);

    expect(screen.getByText('指纹已验证')).toBeInTheDocument();
    expect(screen.getByText('ssh-ed25519')).toBeInTheDocument();
    expect(screen.getByText('SHA256:fixture')).toBeInTheDocument();
    expect(screen.getByText('身份：Production deploy')).toBeInTheDocument();
    expect(screen.getByText('环境：Production')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '清除 Host Key 信任 Production API' }));
    expect(onClearHostKey).toHaveBeenCalledWith(trustedHost);
  });
});
