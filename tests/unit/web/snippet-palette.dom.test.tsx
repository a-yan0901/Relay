// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { SnippetMetadata } from '../../../src/shared/core/models';
import { SnippetPalette } from '../../../src/web/components/SnippetPalette';

const snippets: SnippetMetadata[] = [
  { id: 'snippet-1', name: '健康检查', description: '检查服务', tags: ['ops'], createdAt: '', updatedAt: '' },
  { id: 'snippet-2', name: '发布状态', description: null, tags: ['release'], createdAt: '', updatedAt: '' }
];

describe('SnippetPalette', () => {
  afterEach(() => cleanup());

  it('searches by metadata and returns the selected shared snippet id', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<SnippetPalette snippets={snippets} onSelect={onSelect} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText('搜索命令片段'), 'release');
    expect(screen.getByRole('option', { name: '使用片段 发布状态' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '使用片段 健康检查' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: '使用片段 发布状态' }));
    expect(onSelect).toHaveBeenCalledWith('snippet-2');
  });

  it('uses token-based fuzzy search shared with the quick switcher', async () => {
    const user = userEvent.setup();
    render(<SnippetPalette snippets={snippets} onSelect={vi.fn()} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText('搜索命令片段'), '发布 态');
    expect(screen.getByRole('option', { name: '使用片段 发布状态' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: '使用片段 健康检查' })).not.toBeInTheDocument();
  });
});
