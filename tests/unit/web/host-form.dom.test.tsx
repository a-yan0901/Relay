// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostForm } from '../../../src/web/components/HostForm';
import type { HostMetadataState } from '../../../src/web/state/app-state';
import type { IdentityMetadata } from '../../../src/shared/core/models';

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

  it('submits only changed profile fields when editing a group-inherited host', async () => {
    const user = userEvent.setup();
    const onEditSubmit = vi.fn().mockResolvedValue(undefined);
    const initialHost: HostMetadataState = {
      id: 'host-2',
      name: 'Inherited API',
      address: '10.0.0.10',
      port: 22,
      username: 'ops',
      authType: 'password',
      groupId: 'group-1',
      tags: [],
      isFavorite: false,
      hostKeyAlgorithm: null,
      hostKeyFingerprint: null,
      lastConnectedAt: null,
      createdAt: '2026-09-14T00:00:00.000Z',
      updatedAt: '2026-09-14T00:00:00.000Z',
      credentialSource: { type: 'group' },
      connectionProfile: {
        keepaliveIntervalMs: 10_000,
        keepaliveCountMax: 3,
        reconnect: { enabled: true, maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 5_000 }
      },
      connectionProfileOverrides: null,
      resolvedConnectionProfile: {
        keepaliveIntervalMs: 4_000,
        keepaliveCountMax: 3,
        reconnect: { enabled: true, maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 5_000 }
      }
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

    await user.clear(screen.getByLabelText('Keepalive 次数'));
    await user.type(screen.getByLabelText('Keepalive 次数'), '7');
    await user.click(screen.getByRole('button', { name: '保存修改' }));

    expect(onEditSubmit).toHaveBeenCalledWith(expect.objectContaining({
      connectionProfile: { keepaliveCountMax: 7 }
    }));
  });

  it('uses unchecked jump-host checkboxes for new servers and updates selection', async () => {
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

    const bastionA = screen.getByRole('checkbox', { name: '选择跳板机 Bastion A' });
    const bastionB = screen.getByRole('checkbox', { name: '选择跳板机 Bastion B' });
    const reconnect = screen.getByLabelText('断线后自动重连');
    const favorite = screen.getByLabelText('加入收藏');
    expect(bastionA).toHaveClass('checkbox-input');
    expect(bastionB).toHaveClass('checkbox-input');
    expect(reconnect).toHaveClass('checkbox-input');
    expect(favorite).toHaveClass('checkbox-input');
    expect(bastionA.parentElement).toHaveClass('checkbox-field');
    expect(bastionA.parentElement).not.toHaveClass('jump-host-option');
    expect(bastionB.parentElement).toHaveClass('checkbox-field');
    expect(bastionB.parentElement).not.toHaveClass('jump-host-option');
    expect(bastionA).not.toBeChecked();
    expect(bastionB).not.toBeChecked();

    await user.click(bastionA);
    expect(bastionA).toBeChecked();
    expect(bastionB).not.toBeChecked();

    await user.click(bastionB);
    expect(bastionA).toBeChecked();
    expect(bastionB).toBeChecked();

    await user.click(bastionA);
    expect(bastionA).not.toBeChecked();
    expect(bastionB).toBeChecked();
  });

  it('selects a reusable identity and omits inline credential fields', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const identities: IdentityMetadata[] = [{
      id: 'identity-1', name: 'Production deploy', type: 'password', username: 'deploy',
      keyFingerprint: null, usageCount: 2, createdAt: '', updatedAt: ''
    }];
    render(<HostForm identities={identities} onSubmit={onSubmit} onCancel={vi.fn()} />);

    await user.type(screen.getByLabelText('服务器名称'), 'Production');
    await user.type(screen.getByLabelText('IP / 域名'), '10.0.0.8');
    await user.type(screen.getByLabelText('用户名'), 'deploy');
    await user.selectOptions(screen.getByLabelText('凭据来源'), 'identity');
    expect(screen.queryByLabelText('密码')).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('SSH 身份'), 'identity-1');
    await user.click(screen.getByRole('button', { name: '保存 Server' }));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      credentialSource: { type: 'identity', identityId: 'identity-1' }
    }));
    expect(onSubmit.mock.calls[0][0]).not.toHaveProperty('auth');
  });

  it('uses an Identity username as a form default without overwriting an explicit Host username', async () => {
    const user = userEvent.setup();
    const identities: IdentityMetadata[] = [{
      id: 'identity-1', name: 'Production deploy', type: 'password', username: 'identity-user',
      keyFingerprint: null, usageCount: 0, createdAt: '', updatedAt: ''
    }];
    render(<HostForm identities={identities} onSubmit={vi.fn()} onCancel={vi.fn()} />);

    await user.selectOptions(screen.getByLabelText('凭据来源'), 'identity');
    await user.selectOptions(screen.getByLabelText('SSH 身份'), 'identity-1');
    expect(screen.getByLabelText('用户名')).toHaveValue('identity-user');
    expect(screen.getByText('选择身份时，身份用户名只作为默认值；已填写的 Host 用户名优先。')).toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('凭据来源'), 'inline');
    await user.clear(screen.getByLabelText('用户名'));
    await user.type(screen.getByLabelText('用户名'), 'explicit-user');
    await user.selectOptions(screen.getByLabelText('凭据来源'), 'identity');
    await user.selectOptions(screen.getByLabelText('SSH 身份'), 'identity-1');
    expect(screen.getByLabelText('用户名')).toHaveValue('explicit-user');
  });
});
