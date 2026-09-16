// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostKeyDialog } from '../../../src/web/components/HostKeyDialog';

const challenge = {
  algorithm: 'ssh-ed25519',
  fingerprint: 'SHA256:fixture',
  address: '10.0.0.8',
  port: 22
};

describe('HostKeyDialog accessibility', () => {
  afterEach(() => cleanup());

  it('starts on the safe action, traps focus, and rejects on Escape', async () => {
    const user = userEvent.setup();
    const onDecision = vi.fn();
    render(<HostKeyDialog challenge={challenge} onDecision={onDecision} />);

    const dialog = screen.getByRole('dialog');
    const reject = screen.getByRole('button', { name: '拒绝连接' });
    const trust = screen.getByRole('button', { name: '信任并连接' });
    expect(dialog).toHaveAttribute('aria-describedby', 'host-key-description');
    expect(document.activeElement).toBe(reject);
    await user.tab();
    expect(document.activeElement).toBe(trust);
    await user.tab();
    expect(document.activeElement).toBe(reject);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(onDecision).toHaveBeenCalledWith('reject');
  });
});
