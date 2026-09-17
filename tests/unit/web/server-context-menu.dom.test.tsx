// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { HostMetadataState } from '../../../src/web/state/app-state';
import { ServerContextMenu, type ServerContextActions, type ServerContextTarget } from '../../../src/web/components/ServerContextMenu';

const host: HostMetadataState = {
  id: 'host-1',
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
};

const createActions = (): ServerContextActions => ({
  onConnect: vi.fn(),
  onOpenSftp: vi.fn(),
  onCopyText: vi.fn(),
  onFavoriteToggle: vi.fn(),
  onTagSelected: vi.fn(),
  onTestConnection: vi.fn(),
  onEdit: vi.fn(),
  onClearHostKey: vi.fn(),
  onDelete: vi.fn()
});

const renderMenu = (target: ServerContextTarget, actions = createActions(), selectedTag: string | null = null) => render(
  <ServerContextMenu
    state={{ target, position: { x: 120, y: 80 } }}
    selectedTag={selectedTag}
    actions={actions}
    onClose={vi.fn()}
  />
);

describe('ServerContextMenu', () => {
  afterEach(() => cleanup());

  it('offers safe host actions and formats copyable connection values without secrets', async () => {
    const user = userEvent.setup();
    const actions = createActions();
    renderMenu({ kind: 'host', host }, actions);

    expect(screen.getByRole('menuitem', { name: '进入 Console' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '打开 SFTP' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '清除 Host Key 信任' })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '删除 Server' })).toHaveClass('is-danger');
    expect(screen.queryByText('fixture-password')).not.toBeInTheDocument();

    await user.click(screen.getByRole('menuitem', { name: '复制地址' }));
    await user.click(screen.getByRole('menuitem', { name: '复制 SSH 命令' }));
    expect(actions.onCopyText).toHaveBeenNthCalledWith(1, 'ops@staging.internal.example:2222');
    expect(actions.onCopyText).toHaveBeenNthCalledWith(2, "ssh -p 2222 'ops@staging.internal.example'");
  });

  it('uses the selected tag action to clear an active tag filter', async () => {
    const user = userEvent.setup();
    const actions = createActions();
    renderMenu({ kind: 'tag', tag: 'staging' }, actions, 'staging');

    await user.click(screen.getByRole('menuitem', { name: '清除当前标签筛选' }));
    expect(actions.onTagSelected).toHaveBeenCalledWith(null);
  });

  it('opens a tag filter and copies the tag text', async () => {
    const user = userEvent.setup();
    const actions = createActions();
    renderMenu({ kind: 'tag', tag: 'staging' }, actions);

    await user.click(screen.getByRole('menuitem', { name: '按此标签筛选' }));
    expect(actions.onTagSelected).toHaveBeenCalledWith('staging');

    cleanup();
    renderMenu({ kind: 'tag', tag: 'staging' }, actions);
    await user.click(screen.getByRole('menuitem', { name: '复制标签' }));
    expect(actions.onCopyText).toHaveBeenCalledWith('staging');
  });

  it('does not open a native browser menu on a server target', () => {
    const actions = createActions();
    render(<div data-testid="server-target" onContextMenu={(event) => event.preventDefault()} />);
    fireEvent.contextMenu(screen.getByTestId('server-target'));
    expect(actions.onConnect).not.toHaveBeenCalled();
  });
});
