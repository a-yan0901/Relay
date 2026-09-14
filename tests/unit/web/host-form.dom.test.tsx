// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostForm } from '../../../src/web/components/HostForm';

describe('HostForm', () => {
  afterEach(() => cleanup());

  it('renders server fields with port 22 and switches authentication fields', async () => {
    const user = userEvent.setup();
    render(<HostForm onSubmit={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByLabelText('服务器名称')).toBeInTheDocument();
    expect(screen.getByLabelText('IP / 域名')).toBeInTheDocument();
    expect(screen.getByLabelText('端口')).toHaveValue(22);
    expect(screen.getByLabelText('用户名')).toBeInTheDocument();
    expect(screen.getByLabelText('密码')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('认证方式'), 'private_key');
    expect(screen.getByLabelText('私钥')).toBeInTheDocument();
    expect(screen.getByLabelText('私钥口令')).toBeInTheDocument();
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
  });

  it('shows validation feedback and submits a normalized host without exposing a secret in the form list', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(<HostForm onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '保存 Server' }));
    expect(screen.getByRole('alert')).toHaveTextContent('请检查服务器配置');

    await user.type(screen.getByLabelText('服务器名称'), 'Fixture SSH');
    await user.type(screen.getByLabelText('IP / 域名'), '10.0.0.8');
    await user.type(screen.getByLabelText('用户名'), 'deploy');
    await user.type(screen.getByLabelText('密码'), 'form-secret');
    await user.click(screen.getByRole('button', { name: '保存 Server' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Fixture SSH',
      address: '10.0.0.8',
      port: 22,
      username: 'deploy',
      auth: { type: 'password', password: 'form-secret' }
    }));
  });
});
