// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostForm } from '../../../src/web/components/HostForm';
import type { HostMetadataState } from '../../../src/web/state/app-state';

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

  it('prefills edit metadata and preserves the existing credential when left blank', async () => {
    const user = userEvent.setup();
    const onEditSubmit = vi.fn().mockResolvedValue(undefined);
    const initialHost: HostMetadataState = {
      id: 'host-1',
      name: 'Production API',
      address: '10.0.0.8',
      port: 2222,
      username: 'deploy',
      authType: 'password',
      groupId: 'group-1',
      tags: ['prod', 'api'],
      isFavorite: true,
      hostKeyAlgorithm: 'ssh-ed25519',
      hostKeyFingerprint: 'SHA256:fixture',
      lastConnectedAt: null,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z'
    };
    render(
      <HostForm
        mode="edit"
        initialHost={initialHost}
        groups={[{ id: 'group-1', name: 'Production', sortOrder: 0 }]}
        onEditSubmit={onEditSubmit}
        onCancel={vi.fn()}
      />
    );

    expect(screen.getByRole('heading', { name: '编辑 Server' })).toBeInTheDocument();
    expect(screen.getByLabelText('服务器名称')).toHaveValue('Production API');
    expect(screen.getByLabelText('端口')).toHaveValue(2222);
    expect(screen.getByLabelText('分组')).toHaveValue('group-1');
    await user.clear(screen.getByLabelText('服务器名称'));
    await user.type(screen.getByLabelText('服务器名称'), 'Production Shell');
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    expect(onEditSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Production Shell',
      address: '10.0.0.8',
      port: 2222,
      username: 'deploy',
      groupId: 'group-1',
      tags: ['prod', 'api'],
      isFavorite: true
    }));
    expect(onEditSubmit.mock.calls[0][0]).not.toHaveProperty('auth');
  });

  it('lets users remove a selected jump host with an explicit action', async () => {
    const user = userEvent.setup();
    const jumpHosts: HostMetadataState[] = [
      {
        id: 'jump-1',
        name: 'Bastion A',
        address: '10.0.0.10',
        port: 22,
        username: 'deploy',
        authType: 'password',
        groupId: null,
        tags: [],
        isFavorite: false,
        hostKeyAlgorithm: null,
        hostKeyFingerprint: null,
        lastConnectedAt: null,
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z'
      },
      {
        id: 'jump-2',
        name: 'Bastion B',
        address: '10.0.0.11',
        port: 22,
        username: 'deploy',
        authType: 'password',
        groupId: null,
        tags: [],
        isFavorite: false,
        hostKeyAlgorithm: null,
        hostKeyFingerprint: null,
        lastConnectedAt: null,
        createdAt: '2026-09-14T00:00:00.000Z',
        updatedAt: '2026-09-14T00:00:00.000Z'
      }
    ];

    render(<HostForm hosts={jumpHosts} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText('跳板机（可选，按连接顺序）'), ['jump-1', 'jump-2']);
    await user.click(screen.getByRole('button', { name: '移除跳板机 Bastion A' }));

    expect(screen.getByRole('button', { name: '移除跳板机 Bastion B' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '移除跳板机 Bastion A' })).not.toBeInTheDocument();
    expect(Array.from((screen.getByLabelText('跳板机（可选，按连接顺序）') as HTMLSelectElement).selectedOptions).map((option) => option.value)).toEqual(['jump-2']);

    await user.click(screen.getByRole('button', { name: '清除全部' }));
    expect(screen.queryByRole('button', { name: '移除跳板机 Bastion B' })).not.toBeInTheDocument();
    expect(Array.from((screen.getByLabelText('跳板机（可选，按连接顺序）') as HTMLSelectElement).selectedOptions)).toHaveLength(0);
  });
});
