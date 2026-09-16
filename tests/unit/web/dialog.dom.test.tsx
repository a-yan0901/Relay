// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { Dialog } from '../../../src/web/components/Dialog';

describe('Dialog', () => {
  afterEach(() => cleanup());

  it('focuses the requested control, traps Tab, restores focus, and closes on Escape', async () => {
    const user = userEvent.setup();
    const Harness = () => {
      const [open, setOpen] = useState(false);
      return <>
        <button type="button" onClick={() => setOpen(true)}>打开对话框</button>
        {open && <Dialog title="确认操作" onClose={() => setOpen(false)} initialFocusSelector="#dialog-input"><input id="dialog-input" /><button type="button">继续</button></Dialog>}
      </>;
    };
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '打开对话框' });
    await user.click(trigger);
    const input = screen.getByRole('textbox');
    expect(document.activeElement).toBe(input);

    await user.tab({ shift: true });
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭确认操作' }));
    await user.tab();
    expect(document.activeElement).toBe(input);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: '确认操作' })).not.toBeInTheDocument();
    expect(document.activeElement).toBe(trigger);
  });
});
