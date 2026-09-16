import { describe, expect, it } from 'vitest';

import type { SnippetMetadata, WorkspaceTemplate } from '../../../src/shared/core/models';
import type { GroupSummary, HostMetadataState, TerminalTabState } from '../../../src/web/state/app-state';
import { createQuickSwitcherItems, filterQuickSwitcherItems } from '../../../src/web/state/navigation-state';

const host = (overrides: Partial<HostMetadataState> = {}): HostMetadataState => ({
  id: 'host-prod',
  name: 'Production API',
  address: '10.0.0.8',
  port: 22,
  username: 'deploy',
  authType: 'password',
  groupId: 'group-prod',
  tags: ['prod', 'api'],
  isFavorite: true,
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  lastConnectedAt: '2026-09-16T08:00:00.000Z',
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
  ...overrides
});

const workspaceTemplate: WorkspaceTemplate = {
  id: 'workspace-prod',
  name: '生产排障',
  state: {
    version: 1,
    tabs: [{ id: 'tab-prod', hostId: 'host-prod' }],
    activeTabId: 'tab-prod',
    layout: { mode: 'single', ratio: 0.5 },
    filters: { query: '', groupId: null, favoriteOnly: false }
  },
  createdAt: '2026-09-16T08:00:00.000Z',
  updatedAt: '2026-09-16T08:00:00.000Z'
};

const snippet: SnippetMetadata = {
  id: 'snippet-health',
  name: '检查服务健康度',
  description: '查看 API health endpoint',
  tags: ['ops', 'health'],
  createdAt: '2026-09-16T08:00:00.000Z',
  updatedAt: '2026-09-16T08:00:00.000Z'
};

describe('navigation state', () => {
  it('indexes hosts, open tabs, workspaces and snippets without exposing secrets', () => {
    const terminals: TerminalTabState[] = [{
      terminalId: 'terminal-prod',
      hostId: 'host-prod',
      state: 'connected',
      reconnectDelayMs: 0,
      errorMessage: null
    }];
    const groups: GroupSummary[] = [{ id: 'group-prod', name: 'Production', sortOrder: 0 }];

    const items = createQuickSwitcherItems({
      hosts: [host({ identityName: 'Deploy Key' })],
      groups,
      terminals,
      workspaceTemplates: [workspaceTemplate],
      snippets: [snippet]
    });

    expect(items).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'host', id: 'host-prod', label: 'Production API', tags: ['prod', 'api'] }),
      expect.objectContaining({ type: 'tab', id: 'terminal-prod', label: 'Production API', status: '已连接' }),
      expect.objectContaining({ type: 'workspace', id: 'workspace-prod', label: '生产排障' }),
      expect.objectContaining({ type: 'snippet', id: 'snippet-health', label: '检查服务健康度' })
    ]));
    expect(items.find((item) => item.type === 'host')?.secondary).toContain('Production');
    expect(JSON.stringify(items)).not.toContain('password');
  });

  it('matches group, identity, tags and snippet metadata through one query', () => {
    const items = createQuickSwitcherItems({
      hosts: [host({ identityName: 'Deploy Key' })],
      groups: [{ id: 'group-prod', name: 'Production', sortOrder: 0 }],
      terminals: [],
      workspaceTemplates: [],
      snippets: [snippet]
    });

    expect(filterQuickSwitcherItems(items, 'deploy key')).toEqual([expect.objectContaining({ type: 'host', id: 'host-prod' })]);
    expect(filterQuickSwitcherItems(items, 'production')).toEqual([expect.objectContaining({ type: 'host', id: 'host-prod' })]);
    expect(filterQuickSwitcherItems(items, 'health')).toEqual([expect.objectContaining({ type: 'snippet', id: 'snippet-health' })]);
  });

  it('preserves source order for duplicate labels and returns all items for an empty query', () => {
    const items = createQuickSwitcherItems({
      hosts: [host(), host({ id: 'host-staging', name: 'Production API' })],
      groups: [],
      terminals: [],
      workspaceTemplates: [],
      snippets: []
    });

    expect(filterQuickSwitcherItems(items, '')).toBe(items);
    expect(filterQuickSwitcherItems(items, 'production api').map((item) => item.id)).toEqual(['host-prod', 'host-staging']);
  });
});
