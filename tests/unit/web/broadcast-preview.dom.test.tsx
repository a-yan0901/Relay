// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BroadcastPreview } from '../../../src/web/components/BroadcastPreview';
import type { HostMetadataState, TerminalTabState } from '../../../src/web/state/app-state';

const hosts: HostMetadataState[] = [
  {
    id: 'host-prod', name: 'Production API', address: '10.0.0.8', port: 22, username: 'deploy', authType: 'password', groupId: 'group-prod', tags: ['prod'], isFavorite: false,
    hostKeyAlgorithm: null, hostKeyFingerprint: null, lastConnectedAt: '2026-09-16T08:00:00.000Z', createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z'
  },
  {
    id: 'host-staging', name: 'Staging Shell', address: 'staging.internal', port: 2222, username: 'ops', authType: 'private_key', groupId: 'group-staging', tags: ['staging'], isFavorite: false,
    hostKeyAlgorithm: null, hostKeyFingerprint: null, lastConnectedAt: null, createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z'
  }
];

const terminals: TerminalTabState[] = [
  { terminalId: 'terminal-prod', hostId: 'host-prod', state: 'connected', reconnectDelayMs: 0, errorMessage: null },
  { terminalId: 'terminal-staging', hostId: 'host-staging', state: 'connected', reconnectDelayMs: 0, errorMessage: null },
  { terminalId: 'terminal-connecting', hostId: 'host-prod', state: 'connecting', reconnectDelayMs: 0, errorMessage: null }
];

describe('BroadcastPreview', () => {
  afterEach(() => cleanup());

  it('shows safe target context and confirms a frozen broadcast snapshot', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    render(
      <BroadcastPreview
        workspaceId="workspace-current"
        hosts={hosts}
        groups={[{ id: 'group-prod', name: 'Production', sortOrder: 0 }, { id: 'group-staging', name: 'Staging', sortOrder: 1 }]}
        terminals={terminals}
        workspaceTabIdByTerminalId={{ 'terminal-prod': 'tab-prod', 'terminal-staging': 'tab-staging', 'terminal-connecting': 'tab-connecting' }}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole('dialog', { name: '广播执行预览' })).toHaveTextContent('2 个可写 Console');
    expect(screen.getByText('环境：Production')).toBeInTheDocument();
    expect(screen.getByText('deploy')).toBeInTheDocument();
    expect(screen.getByText('高风险：多会话广播')).toBeInTheDocument();
    expect(screen.getByText(/并发 4/)).toBeInTheDocument();
    expect(screen.getByText('执行中可从结果面板取消')).toBeInTheDocument();
    expect(screen.queryByText('连接中')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '确认并填写命令' }));
    expect(onConfirm).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: 'workspace-current',
      tabIds: ['tab-prod', 'tab-staging'],
      hostIds: ['host-prod', 'host-staging'],
      highRisk: true
    }));
  });

  it('does not allow Broadcast with fewer than two writable sessions', () => {
    render(
      <BroadcastPreview
        workspaceId={null}
        hosts={hosts}
        groups={[]}
        terminals={[terminals[0], terminals[2]]}
        onConfirm={vi.fn()}
        onClose={vi.fn()}
      />
    );

    expect(screen.getByRole('status')).toHaveTextContent('至少需要两个可写 Console');
    expect(screen.getByRole('button', { name: '确认并填写命令' })).toBeDisabled();
  });
});
