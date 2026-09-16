// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GroupNode } from '../../../src/shared/core/models.js';
import type { HostMetadata } from '../../../src/shared/validation.js';
import { HostTargetPicker } from '../../../src/web/components/HostTargetPicker';
import type { TargetSelection } from '../../../src/shared/core/models.js';

const host = (id: string, name: string, groupId: string | null, isFavorite = false): HostMetadata => ({
  id, name, address: `10.0.0.${id.slice(-1)}`, port: 22, username: 'deploy', authType: 'password', groupId,
  tags: [], isFavorite, hostKeyAlgorithm: null, hostKeyFingerprint: null, lastConnectedAt: null,
  createdAt: '2026-09-15T00:00:00.000Z', updatedAt: '2026-09-15T00:00:00.000Z'
});

const groups: GroupNode[] = [
  { id: 'prod', name: 'Production', parentId: null, sortOrder: 0, defaultIdentityId: null, connectionProfile: null },
  { id: 'api', name: 'API', parentId: 'prod', sortOrder: 0, defaultIdentityId: null, connectionProfile: null }
];

describe('HostTargetPicker', () => {
  afterEach(() => cleanup());

  it('selects a nested group, filters the view, and reports explicit host snapshots', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const selection: TargetSelection = { hostIds: [], groupIds: [], favoriteOnly: false, query: '' };
    const hosts = [host('host-1', 'Production Shell', 'prod', true), host('host-2', 'API Shell', 'api'), host('host-3', 'Standalone', null)];
    const Harness = () => {
      const [current, setCurrent] = useState(selection);
      return <HostTargetPicker hosts={hosts} groups={groups} selection={current} onChange={(next) => { onChange(next); setCurrent(next); }} />;
    };
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: '选择分组 Production' }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ groupIds: ['prod'], hostIds: ['host-1', 'host-2'], source: 'group' }));

    await user.click(screen.getByRole('button', { name: '仅显示收藏' }));
    expect(screen.getByRole('checkbox', { name: '选择目标 Production Shell' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: '选择目标 API Shell' })).not.toBeInTheDocument();
  });

  it('reuses recent and tag filters when choosing batch targets', async () => {
    const user = userEvent.setup();
    const selection: TargetSelection = { hostIds: [], groupIds: [], favoriteOnly: false, query: '' };
    const hosts = [
      { ...host('host-1', 'Production Shell'), tags: ['prod'], lastConnectedAt: '2026-09-16T08:00:00.000Z' },
      { ...host('host-2', 'Staging Shell'), tags: ['staging'] }
    ];
    render(<HostTargetPicker hosts={hosts} groups={groups} selection={selection} onChange={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: '最近' }));
    expect(screen.getByRole('checkbox', { name: '选择目标 Production Shell' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '选择目标 Staging Shell' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '按标签 staging' }));
    expect(screen.getByRole('checkbox', { name: '选择目标 Staging Shell' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: '选择目标 Production Shell' })).not.toBeInTheDocument();
  });
});
