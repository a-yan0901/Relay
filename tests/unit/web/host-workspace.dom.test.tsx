// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostWorkspace } from '../../../src/web/components/HostWorkspace';
import type { HostMetadataState } from '../../../src/web/state/app-state';

const hosts: HostMetadataState[] = [
  {
    id: 'host-1',
    name: 'Production API',
    address: '10.0.0.8',
    port: 22,
    username: 'deploy',
    authType: 'password',
    groupId: 'group-1',
    tags: ['prod', 'api'],
    isFavorite: true,
    hostKeyAlgorithm: null,
    hostKeyFingerprint: null,
    lastConnectedAt: null,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z'
  },
  {
    id: 'host-2',
    name: 'Staging Shell',
    address: 'staging.internal.example',
    port: 2222,
    username: 'ops',
    authType: 'private_key',
    groupId: null,
    tags: ['staging'],
    isFavorite: false,
    hostKeyAlgorithm: 'ssh-ed25519',
    hostKeyFingerprint: 'SHA256:fixture',
    lastConnectedAt: null,
    createdAt: '2026-09-14T00:00:00.000Z',
    updatedAt: '2026-09-14T00:00:00.000Z'
  }
];

const groups = [
  { id: 'group-1', name: 'Production', sortOrder: 0 },
  { id: 'group-2', name: 'Staging', sortOrder: 1 }
];

describe('HostWorkspace', () => {
  afterEach(() => cleanup());

  it('searches host metadata, filters by group, and toggles favorites', async () => {
    const user = userEvent.setup();
    const onQueryChange = vi.fn();
    const onGroupSelected = vi.fn();
    const onFavoriteToggle = vi.fn();
    render(
      <HostWorkspace
        hosts={hosts}
        groups={groups}
        query=""
        selectedGroupId={null}
        favoriteOnly={false}
        onQueryChange={onQueryChange}
        onGroupSelected={onGroupSelected}
        onFavoriteFilter={vi.fn()}
        onFavoriteToggle={onFavoriteToggle}
        onConnect={vi.fn()}
        onAddHost={vi.fn()}
      />
    );

    expect(screen.getByText('Production API')).toBeInTheDocument();
    expect(screen.getByText('Staging Shell')).toBeInTheDocument();
    await user.type(screen.getByRole('searchbox', { name: '搜索 Server' }), '10.0.0.8');
    expect(onQueryChange).toHaveBeenLastCalledWith('8');
    await user.click(screen.getByRole('button', { name: 'Production' }));
    expect(onGroupSelected).toHaveBeenCalledWith('group-1');
    await user.click(screen.getByRole('button', { name: '收藏 Production API' }));
    expect(onFavoriteToggle).toHaveBeenCalledWith(hosts[0]);
  });

  it('switches between list and grid server views without changing host actions', async () => {
    const user = userEvent.setup();
    const onViewModeChange = vi.fn();
    render(
      <HostWorkspace
        hosts={hosts}
        groups={groups}
        query=""
        selectedGroupId={null}
        favoriteOnly={false}
        viewMode="list"
        onViewModeChange={onViewModeChange}
        onQueryChange={vi.fn()}
        onGroupSelected={vi.fn()}
        onFavoriteFilter={vi.fn()}
        onFavoriteToggle={vi.fn()}
        onConnect={vi.fn()}
        onAddHost={vi.fn()}
      />
    );

    expect(screen.getByRole('button', { name: '列表视图' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Server 列表')).toHaveClass('is-list');
    await user.click(screen.getByRole('button', { name: '网格视图' }));
    expect(onViewModeChange).toHaveBeenCalledWith('grid');
  });

  it('shows separate import and export entries on the Vault page', async () => {
    const user = userEvent.setup();
    const onImport = vi.fn();
    const onExport = vi.fn();
    render(
      <HostWorkspace
        hosts={hosts}
        groups={groups}
        query=""
        selectedGroupId={null}
        favoriteOnly={false}
        onQueryChange={vi.fn()}
        onGroupSelected={vi.fn()}
        onFavoriteFilter={vi.fn()}
        onFavoriteToggle={vi.fn()}
        onConnect={vi.fn()}
        onAddHost={vi.fn()}
        onImport={onImport}
        onExport={onExport}
      />
    );

    await user.click(screen.getByRole('button', { name: '导入' }));
    await user.click(screen.getByRole('button', { name: '导出' }));
    expect(onImport).toHaveBeenCalledOnce();
    expect(onExport).toHaveBeenCalledOnce();
    expect(screen.queryByText('Vault 已解锁')).not.toBeInTheDocument();
  });

  it('offers a first-server action when the filtered list is empty', () => {
    const onAddHost = vi.fn();
    render(
      <HostWorkspace
        hosts={[]}
        groups={[]}
        query=""
        selectedGroupId={null}
        favoriteOnly={false}
        onQueryChange={vi.fn()}
        onGroupSelected={vi.fn()}
        onFavoriteToggle={vi.fn()}
        onConnect={vi.fn()}
        onAddHost={onAddHost}
      />
    );

    expect(screen.getByText('还没有 Server')).toBeInTheDocument();
    screen.getByRole('button', { name: '添加第一台 Server' }).click();
    expect(onAddHost).toHaveBeenCalledOnce();
  });

  it('sorts favorite servers by most recent connection first', () => {
    const recentHosts = [
      { ...hosts[0], lastConnectedAt: '2026-09-14T08:00:00.000Z' },
      { ...hosts[1], isFavorite: true, lastConnectedAt: '2026-09-14T09:00:00.000Z' }
    ];
    render(
      <HostWorkspace
        hosts={recentHosts}
        groups={groups}
        query=""
        selectedGroupId={null}
        favoriteOnly={false}
        onQueryChange={vi.fn()}
        onGroupSelected={vi.fn()}
        onFavoriteFilter={vi.fn()}
        onFavoriteToggle={vi.fn()}
        onConnect={vi.fn()}
        onAddHost={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        onTestConnection={vi.fn()}
      />
    );

    const cards = screen.getByLabelText('Server 列表').querySelectorAll('.host-card');
    expect(cards[0]).toHaveTextContent('Staging Shell');
    expect(cards[1]).toHaveTextContent('Production API');
  });

  it('includes hosts from nested groups when a parent group is selected', () => {
    render(
      <HostWorkspace
        hosts={hosts}
        groups={[
          { id: 'group-1', name: 'Production', sortOrder: 0, parentId: null },
          { id: 'group-api', name: 'API', sortOrder: 0, parentId: 'group-1' }
        ]}
        query=""
        selectedGroupId="group-1"
        favoriteOnly={false}
        onQueryChange={vi.fn()}
        onGroupSelected={vi.fn()}
        onFavoriteFilter={vi.fn()}
        onFavoriteToggle={vi.fn()}
        onConnect={vi.fn()}
        onAddHost={vi.fn()}
      />
    );

    expect(screen.getByText('Production API')).toBeInTheDocument();
  });

  it('exposes recent and tag filters from the same Server navigation', async () => {
    const user = userEvent.setup();
    const onRecentFilter = vi.fn();
    const onTagSelected = vi.fn();
    render(
      <HostWorkspace
        hosts={hosts}
        groups={groups}
        query=""
        selectedGroupId={null}
        favoriteOnly={false}
        recentOnly={false}
        selectedTag={null}
        onQueryChange={vi.fn()}
        onGroupSelected={vi.fn()}
        onFavoriteFilter={vi.fn()}
        onRecentFilter={onRecentFilter}
        onTagSelected={onTagSelected}
        onFavoriteToggle={vi.fn()}
        onConnect={vi.fn()}
        onAddHost={vi.fn()}
      />
    );

    const navigation = screen.getByRole('complementary', { name: 'Server 导航' });
    await user.click(within(navigation).getByRole('button', { name: '最近' }));
    await user.click(within(navigation).getByRole('button', { name: '标签 prod' }));

    expect(onRecentFilter).toHaveBeenCalledWith(true);
    expect(onTagSelected).toHaveBeenCalledWith('prod');
  });

  it('filters the Server list by recent connection and explicit tag', () => {
    render(
      <HostWorkspace
        hosts={hosts.map((host) => host.id === 'host-2' ? { ...host, lastConnectedAt: '2026-09-16T08:00:00.000Z' } : host)}
        groups={groups}
        query=""
        selectedGroupId={null}
        favoriteOnly={false}
        recentOnly
        selectedTag="staging"
        onQueryChange={vi.fn()}
        onGroupSelected={vi.fn()}
        onFavoriteFilter={vi.fn()}
        onRecentFilter={vi.fn()}
        onTagSelected={vi.fn()}
        onFavoriteToggle={vi.fn()}
        onConnect={vi.fn()}
        onAddHost={vi.fn()}
      />
    );

    expect(screen.getByText('Staging Shell')).toBeInTheDocument();
    expect(screen.queryByText('Production API')).not.toBeInTheDocument();
  });

  it('shows the active filter and clears it from the workspace toolbar', async () => {
    const user = userEvent.setup();
    const onGroupSelected = vi.fn();
    const onFavoriteFilter = vi.fn();
    const onRecentFilter = vi.fn();
    const onTagSelected = vi.fn();
    render(
      <HostWorkspace
        hosts={hosts}
        groups={groups}
        query=""
        selectedGroupId={null}
        favoriteOnly={false}
        recentOnly
        selectedTag="prod"
        onQueryChange={vi.fn()}
        onGroupSelected={onGroupSelected}
        onFavoriteFilter={onFavoriteFilter}
        onRecentFilter={onRecentFilter}
        onTagSelected={onTagSelected}
        onFavoriteToggle={vi.fn()}
        onConnect={vi.fn()}
        onAddHost={vi.fn()}
      />
    );

    expect(screen.getByText('标签：prod')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(onGroupSelected).toHaveBeenCalledWith(null);
    expect(onFavoriteFilter).toHaveBeenCalledWith(false);
    expect(onRecentFilter).toHaveBeenCalledWith(false);
    expect(onTagSelected).toHaveBeenCalledWith(null);
  });

  it('opens tag actions from both a card tag and the sidebar tag filter', async () => {
    const user = userEvent.setup();
    const onCopyText = vi.fn();
    render(
      <HostWorkspace
        hosts={hosts}
        groups={groups}
        query=""
        selectedGroupId={null}
        favoriteOnly={false}
        selectedTag={null}
        onQueryChange={vi.fn()}
        onGroupSelected={vi.fn()}
        onFavoriteFilter={vi.fn()}
        onFavoriteToggle={vi.fn()}
        onConnect={vi.fn()}
        onAddHost={vi.fn()}
        onCopyText={onCopyText}
      />
    );

    fireEvent.contextMenu(screen.getByRole('button', { name: '筛选标签 prod' }), { clientX: 100, clientY: 100 });
    await user.click(screen.getByRole('menuitem', { name: '复制标签' }));
    expect(onCopyText).toHaveBeenCalledWith('prod');

    fireEvent.contextMenu(screen.getByRole('button', { name: '标签 api' }), { clientX: 100, clientY: 100 });
    await user.click(screen.getByRole('menuitem', { name: '按此标签筛选' }));
  });
});
