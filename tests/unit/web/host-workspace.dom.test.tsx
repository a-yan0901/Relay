// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
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
});
