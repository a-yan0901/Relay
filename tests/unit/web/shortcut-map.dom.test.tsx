// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { ShortcutMap } from '../../../src/web/components/ShortcutMap';

describe('ShortcutMap', () => {
  afterEach(() => cleanup());

  it('searches the shortcut map without losing action context', async () => {
    const user = userEvent.setup();
    render(<ShortcutMap />);

    const map = screen.getByRole('region', { name: '快捷键' });
    expect(map).toHaveTextContent('快速切换');
    await user.type(screen.getByRole('searchbox', { name: '搜索快捷键' }), '片段');

    expect(map).toHaveTextContent('打开命令片段');
    expect(map).not.toHaveTextContent('快速切换');
    expect(map).toHaveTextContent('Ctrl/Cmd+Shift+P');
  });
});
