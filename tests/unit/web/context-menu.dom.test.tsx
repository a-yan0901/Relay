// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ContextMenu } from '../../../src/web/components/ContextMenu';
import { isNativeContextMenuTarget, type ContextMenuItem } from '../../../src/web/context-menu';
import { useContextMenu } from '../../../src/web/hooks/use-context-menu';

const Fixture = ({ onCopy = vi.fn() }: { onCopy?: () => void }) => {
  const menu = useContextMenu<string>();
  const items: ContextMenuItem[] = [
    { id: 'copy', label: '复制', onSelect: onCopy },
    { id: 'disabled', label: '不可用', disabled: true, onSelect: vi.fn() },
    { id: 'clear', label: '清除', onSelect: menu.close }
  ];

  return <>
    <button type="button" data-testid="custom-surface" onContextMenu={(event) => menu.open(event, 'surface')}>打开菜单</button>
    <input aria-label="可编辑输入" />
    {menu.state && <ContextMenu state={menu.state} items={items} onClose={menu.close} />}
  </>;
};

describe('ContextMenu', () => {
  afterEach(() => cleanup());

  it('opens from a right click, focuses the first item, skips disabled items, and executes with Enter', async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    render(<Fixture onCopy={onCopy} />);

    fireEvent.contextMenu(screen.getByTestId('custom-surface'), { clientX: 80, clientY: 120 });

    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: '复制' })).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(onCopy).toHaveBeenCalledOnce();
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId('custom-surface'), { clientX: 80, clientY: 120 });
    await user.keyboard('{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: '清除' })).toHaveFocus();
  });

  it('closes with Escape and outside click', async () => {
    const user = userEvent.setup();
    render(<Fixture />);

    fireEvent.contextMenu(screen.getByTestId('custom-surface'), { clientX: 80, clientY: 120 });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId('custom-surface'), { clientX: 80, clientY: 120 });
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
  });

  it('keeps native context menus for editable and explicitly allowed targets', () => {
    const { container } = render(<Fixture />);
    const input = screen.getByLabelText('可编辑输入');
    const link = document.createElement('a');
    const allowed = document.createElement('div');
    allowed.dataset.nativeContextMenu = 'true';
    container.append(input, link, allowed);

    expect(isNativeContextMenuTarget(input)).toBe(true);
    expect(isNativeContextMenuTarget(link)).toBe(true);
    expect(isNativeContextMenuTarget(allowed)).toBe(true);
    expect(isNativeContextMenuTarget(screen.getByTestId('custom-surface'))).toBe(false);
  });
});
