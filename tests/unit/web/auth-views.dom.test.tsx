// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@shared/errors';
import { SetupGate } from '../../../src/web/components/SetupGate';
import { UnlockView } from '../../../src/web/components/UnlockView';

describe('authentication views', () => {
  afterEach(() => cleanup());

  it('shows boot errors and validates the eight-character setup minimum', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<SetupGate onSubmit={onSubmit} errorMessage="服务暂时不可用" />);

    expect(screen.getByRole('alert')).toHaveTextContent('服务暂时不可用');
    await user.type(screen.getByLabelText('主密码'), '1234567');
    await user.type(screen.getByLabelText('确认主密码'), '1234567');
    await user.click(screen.getByRole('button', { name: '创建 Vault' }));

    expect(screen.getByRole('alert')).toHaveTextContent('主密码至少需要 8 个字符');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps the unlock input and exposes a rejected unlock attempt', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new AppError('VAULT_UNLOCK_FAILED'));
    render(<UnlockView onSubmit={onSubmit} />);

    const input = screen.getByLabelText('主密码');
    await user.type(input, 'wrongpass');
    await user.click(screen.getByRole('button', { name: '解锁 Vault' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('主密码错误或 Vault 已损坏');
    expect(input).toHaveValue('wrongpass');
  });

  it('blocks short unlock passwords before making a request', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<UnlockView onSubmit={onSubmit} />);

    await user.type(screen.getByLabelText('主密码'), '1234567');
    await user.click(screen.getByRole('button', { name: '解锁 Vault' }));

    expect(screen.getByRole('alert')).toHaveTextContent('主密码至少需要 8 个字符');
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
