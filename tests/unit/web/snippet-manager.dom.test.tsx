// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Snippet, SnippetMetadata } from '../../../src/shared/core/models';
import { SnippetManager } from '../../../src/web/components/SnippetManager';

const metadata: SnippetMetadata = {
  id: 'snippet-1', name: '健康检查', description: '检查服务状态', tags: ['ops'], createdAt: '', updatedAt: ''
};

const snippet: Snippet = {
  ...metadata, command: 'systemctl status {{service}}', variables: ['service']
};

describe('SnippetManager', () => {
  afterEach(() => cleanup());

  it('creates a snippet and derives its declared variables from the command', async () => {
    const user = userEvent.setup();
    const onCreate = vi.fn(async () => {});
    render(<SnippetManager snippets={[]} onGet={vi.fn(async () => null)} onCreate={onCreate} onUpdate={vi.fn(async () => {})} onDelete={vi.fn(async () => {})} onClose={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '新建片段' }));
    await user.type(screen.getByLabelText('片段名称'), '检查服务');
    fireEvent.change(screen.getByLabelText('命令'), { target: { value: 'systemctl status {{service}}' } });
    await user.click(screen.getByRole('button', { name: '保存片段' }));

    expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
      name: '检查服务', command: 'systemctl status {{service}}', variables: ['service']
    }));
  });

  it('loads an existing snippet before editing and filters metadata by name and tag', async () => {
    const user = userEvent.setup();
    const onGet = vi.fn(async () => snippet);
    render(<SnippetManager snippets={[metadata]} onGet={onGet} onCreate={vi.fn(async () => {})} onUpdate={vi.fn(async () => {})} onDelete={vi.fn(async () => {})} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText('搜索片段'), 'ops');
    expect(screen.getByText('健康检查')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '编辑 健康检查' }));
    expect(onGet).toHaveBeenCalledWith('snippet-1');
    expect(await screen.findByDisplayValue('systemctl status {{service}}')).toBeInTheDocument();
  });
});
