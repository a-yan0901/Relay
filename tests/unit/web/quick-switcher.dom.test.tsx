// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { QuickSwitcher } from '../../../src/web/components/QuickSwitcher';
import type { QuickSwitcherItem } from '../../../src/web/state/navigation-state';

const items: QuickSwitcherItem[] = [
  { type: 'host', id: 'host-prod', label: 'Production API', secondary: 'deploy@10.0.0.8:22', tags: ['prod'] },
  { type: 'host', id: 'host-staging', label: 'Staging Shell', secondary: 'ops@staging.internal:22', tags: ['staging'] },
  { type: 'workspace', id: 'workspace-prod', label: '生产排障', secondary: '2 个 Console · 分屏' },
  { type: 'snippet', id: 'snippet-health', label: '检查服务健康度', secondary: '查看 API health endpoint' }
];

describe('QuickSwitcher', () => {
  afterEach(() => cleanup());

  it('filters results and selects the highlighted item with Enter', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<QuickSwitcher items={items} onSelect={onSelect} onClose={vi.fn()} />);

    const search = screen.getByRole('searchbox', { name: '快速搜索' });
    expect(document.activeElement).toBe(search);
    await user.type(search, 'staging');
    expect(screen.getByRole('option', { name: /Staging Shell/u })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Production API/u })).not.toBeInTheDocument();
    await user.keyboard('{Enter}');

    expect(onSelect).toHaveBeenCalledWith(items[1]);
  });

  it('moves the active result with arrow keys and exposes an empty state', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<QuickSwitcher items={items} onSelect={onSelect} onClose={vi.fn()} />);

    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith(items[2]);

    cleanup();
    render(<QuickSwitcher items={items} onSelect={onSelect} onClose={vi.fn()} />);
    await user.type(screen.getByRole('searchbox', { name: '快速搜索' }), 'not-found');
    expect(screen.getByText('没有匹配的结果')).toBeInTheDocument();
  });

  it('closes on Escape without changing the selected item', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onClose = vi.fn();
    render(<QuickSwitcher items={items} onSelect={onSelect} onClose={onClose} />);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
