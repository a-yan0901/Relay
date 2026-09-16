// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { WorkspaceTemplate } from '../../../src/shared/core/models';
import { WorkspaceSwitcher } from '../../../src/web/components/WorkspaceSwitcher';

const workspace = (tabs: Array<{ id: string; hostId: string }>) => ({
  version: 1,
  tabs,
  activeTabId: tabs[0]?.id ?? null,
  layout: { mode: 'single' as const, ratio: 0.5 },
  filters: { query: '', groupId: null, favoriteOnly: false }
});

const template: WorkspaceTemplate = {
  id: 'template-1',
  name: '生产排障',
  state: workspace([{ id: 'tab-template', hostId: 'host-2' }]),
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z'
};

describe('WorkspaceSwitcher', () => {
  afterEach(() => cleanup());

  it('saves and deletes a named workspace template', async () => {
    const user = userEvent.setup();
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<WorkspaceSwitcher templates={[template]} currentWorkspace={workspace([])} hosts={[]} onOpen={vi.fn()} onSave={onSave} onDelete={onDelete} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '保存当前' }));
    await user.type(screen.getByLabelText('工作区名称'), '排障');
    await user.click(screen.getByRole('button', { name: '保存', exact: true }));
    expect(onSave).toHaveBeenCalledWith('排障');

    await user.click(screen.getByRole('button', { name: '删除工作区 生产排障' }));
    await user.click(screen.getByRole('button', { name: '确认删除' }));
    expect(onDelete).toHaveBeenCalledWith('template-1');
  });

  it('asks before closing live tabs absent from a template', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<WorkspaceSwitcher templates={[template]} currentWorkspace={workspace([{ id: 'tab-live', hostId: 'host-1' }])} hosts={[{ id: 'host-1', name: 'Production' } as never]} onOpen={onOpen} onSave={vi.fn()} onDelete={vi.fn()} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '生产排障1 个 Console · 单面板' }));
    expect(screen.getByText('Production')).toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: '继续切换' }));
    expect(onOpen).toHaveBeenCalledWith(template);
  });
});
