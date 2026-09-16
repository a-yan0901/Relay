import { describe, expect, it } from 'vitest';

import type { TerminalStatus } from '@shared/protocol';
import type { WorkspaceState } from '@shared/core/models';
import {
  appReducer,
  initialAppState,
  type AppState,
  type HostMetadataState
} from '../../../src/web/state/app-state';
import { restoreWorkspace, workspaceStateFromAppState } from '../../../src/web/state/workspace-state';

const host = (overrides: Partial<HostMetadataState> = {}): HostMetadataState => ({
  id: 'host-1',
  name: 'Production API',
  address: '10.0.0.8',
  port: 22,
  username: 'deploy',
  authType: 'password',
  groupId: null,
  tags: ['prod'],
  isFavorite: false,
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  lastConnectedAt: null,
  createdAt: '2026-09-14T00:00:00.000Z',
  updatedAt: '2026-09-14T00:00:00.000Z',
  ...overrides
});

describe('appReducer', () => {
  it('returns a recovery result for every workspace tab', () => {
    const workspace: WorkspaceState = {
      version: 4,
      tabs: [
        { id: 'tab-live', hostId: 'host-1', title: 'Live' },
        { id: 'tab-reopen', hostId: 'host-2', title: 'Reopen' },
        { id: 'tab-missing', hostId: 'host-deleted', title: 'Missing' }
      ],
      activeTabId: 'tab-live',
      layout: { mode: 'horizontal', ratio: 0.7 },
      filters: { query: 'prod', groupId: null, favoriteOnly: false }
    };

    expect(restoreWorkspace(
      workspace,
      new Set(['host-1', 'host-2']),
      [{ terminalId: 'terminal-live', hostId: 'host-1', workspaceTabId: 'tab-live' }],
      (() => {
        const ids = ['terminal-reopen', 'terminal-missing'];
        return () => ids.shift() ?? 'terminal-fallback';
      })()
    )).toEqual([
      { tabId: 'tab-live', hostId: 'host-1', title: 'Live', status: 'restored', terminalId: 'terminal-live' },
      { tabId: 'tab-reopen', hostId: 'host-2', title: 'Reopen', status: 'needs-reopen', terminalId: 'terminal-reopen' },
      { tabId: 'tab-missing', hostId: 'host-deleted', title: 'Missing', status: 'missing-host', terminalId: 'terminal-missing' }
    ]);
  });

  it('hydrates durable workspace tabs into fresh live terminal ids', () => {
    const workspace: WorkspaceState = {
      version: 4,
      tabs: [
        { id: 'tab-intent-1', hostId: 'host-1', title: 'Production' },
        { id: 'tab-intent-2', hostId: 'host-2' }
      ],
      activeTabId: 'tab-intent-2',
      layout: { mode: 'horizontal', ratio: 0.7 },
      filters: { query: 'prod', groupId: null, favoriteOnly: false }
    };
    const hydrated = appReducer(initialAppState, {
      type: 'workspaceLoaded',
      workspace,
      terminalIds: {
        'tab-intent-1': 'terminal-new-1',
        'tab-intent-2': 'terminal-new-2'
      }
    });

    expect(hydrated.terminals.map(({ terminalId, hostId }) => ({ terminalId, hostId }))).toEqual([
      { terminalId: 'terminal-new-1', hostId: 'host-1' },
      { terminalId: 'terminal-new-2', hostId: 'host-2' }
    ]);
    expect(hydrated.activeTerminalId).toBe('terminal-new-2');
    expect(hydrated.workspace).toEqual(workspace);
    expect(hydrated.query).toBe('prod');
  });

  it('keeps durable workspace data free of live terminal state', () => {
    let state = appReducer(initialAppState, { type: 'terminalOpened', terminalId: 'live-terminal', hostId: 'host-1' });
    state = appReducer(state, { type: 'workspaceSynced', workspace: {
      version: 1,
      tabs: [{ id: 'intent-1', hostId: 'host-1' }],
      activeTabId: 'intent-1',
      layout: { mode: 'single', ratio: 0.5 },
      filters: { query: '', groupId: null, favoriteOnly: false }
    } });

    expect(state.workspace.tabs[0]).toEqual({ id: 'intent-1', hostId: 'host-1' });
    expect(JSON.stringify(state.workspace)).not.toContain('live-terminal');
  });

  it('moves through setup, unlocked, and locked states', () => {
    const setup = appReducer(initialAppState, { type: 'setup', initialized: false });
    expect(setup.phase).toBe('setup');
    const locked = appReducer(setup, { type: 'setup', initialized: true, locked: true });
    expect(locked.phase).toBe('locked');
    const unlocked = appReducer(locked, { type: 'unlock' });
    expect(unlocked.phase).toBe('ready');
    expect(appReducer(unlocked, { type: 'lock' }).phase).toBe('locked');
  });

  it('replaces host metadata without retaining submitted credentials', () => {
    const secretBearingHost = {
      ...host(),
      password: 'must-not-enter-state',
      privateKey: '-----BEGIN PRIVATE KEY-----'
    } as unknown as HostMetadataState;
    const state = appReducer(initialAppState, { type: 'hostsLoaded', hosts: [secretBearingHost] });

    expect(state.hosts).toEqual([host()]);
    expect(JSON.stringify(state.hosts)).not.toContain('must-not-enter-state');
    expect(JSON.stringify(state.hosts)).not.toContain('BEGIN PRIVATE KEY');
  });

  it('rolls an optimistic favorite update back when the API fails', () => {
    const loaded = appReducer(initialAppState, { type: 'hostsLoaded', hosts: [host()] });
    const optimistic = appReducer(loaded, { type: 'favoriteOptimistic', hostId: 'host-1', isFavorite: true });
    expect(optimistic.hosts[0].isFavorite).toBe(true);
    const rolledBack = appReducer(optimistic, { type: 'favoriteRollback', hostId: 'host-1' });
    expect(rolledBack.hosts[0].isFavorite).toBe(false);
  });

  it('keeps the server-confirmed favorite after a successful API update', () => {
    const loaded = appReducer(initialAppState, { type: 'hostsLoaded', hosts: [host()] });
    const optimistic = appReducer(loaded, { type: 'favoriteOptimistic', hostId: 'host-1', isFavorite: true });
    const confirmed = appReducer(optimistic, { type: 'hostUpdated', host: host({ isFavorite: true, updatedAt: '2026-09-15T00:00:00.000Z' }) });
    const committed = appReducer(confirmed, { type: 'favoriteCommitted', hostId: 'host-1' });

    expect(committed.hosts[0].isFavorite).toBe(true);
    expect(committed.favoriteRollback).toEqual({});
  });

  it('tracks query/group filters and multiple terminal tabs', () => {
    let state: AppState = appReducer(initialAppState, {
      type: 'hostsLoaded',
      hosts: [host(), host({ id: 'host-2', groupId: 'group-1', name: 'Staging Shell' })]
    });
    state = appReducer(state, { type: 'queryChanged', query: 'staging' });
    state = appReducer(state, { type: 'groupSelected', groupId: 'group-1' });
    state = appReducer(state, { type: 'favoriteFilterChanged', favoriteOnly: true });
    expect(state.query).toBe('staging');
    expect(state.selectedGroupId).toBe('group-1');
    expect(state.favoriteOnly).toBe(true);

    state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-1', hostId: 'host-1' });
    state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-2', hostId: 'host-2' });
    expect(state.terminals).toEqual([
      { terminalId: 'tab-1', hostId: 'host-1', state: 'closed', reconnectDelayMs: 0, errorMessage: null },
      { terminalId: 'tab-2', hostId: 'host-2', state: 'closed', reconnectDelayMs: 0, errorMessage: null }
    ]);
    expect(state.activeTerminalId).toBe('tab-2');
  });

  it('keeps a deleted host tab as an explicit missing-host recovery item', () => {
    let state = appReducer(initialAppState, { type: 'terminalOpened', terminalId: 'terminal-1', hostId: 'host-1', workspaceTabId: 'tab-1' });
    state = appReducer(state, { type: 'hostDeleted', hostId: 'host-1' });

    expect(state.workspace.tabs).toEqual([{ id: 'tab-1', hostId: 'host-1' }]);
    expect(state.terminals).toEqual([expect.objectContaining({
      terminalId: 'terminal-1',
      state: 'needs-reopen',
      recoveryStatus: 'missing-host'
    })]);
    expect(workspaceStateFromAppState(state).tabs).toEqual([{ id: 'tab-1', hostId: 'host-1' }]);
  });

  it('updates the recovery summary when a restored session is lost and reopened', () => {
    const workspace: WorkspaceState = {
      version: 1,
      tabs: [{ id: 'tab-1', hostId: 'host-1' }],
      activeTabId: 'tab-1',
      layout: { mode: 'single', ratio: 0.5 },
      filters: { query: '', groupId: null, favoriteOnly: false }
    };
    let state = appReducer(initialAppState, {
      type: 'workspaceLoaded',
      workspace,
      terminalIds: { 'tab-1': 'terminal-1' },
      restoreResults: [{ tabId: 'tab-1', hostId: 'host-1', status: 'restored', terminalId: 'terminal-1' }]
    });
    state = appReducer(state, {
      type: 'terminalStatusUpdated',
      terminalId: 'terminal-1',
      state: 'needs-reopen',
      reconnectDelayMs: 0,
      errorMessage: '服务已重启，请重新打开终端'
    });
    expect(state.workspaceRecovery[0]?.status).toBe('needs-reopen');
    expect(state.terminals[0]?.recoveryStatus).toBe('needs-reopen');

    state = appReducer(state, {
      type: 'terminalStatusUpdated',
      terminalId: 'terminal-1',
      state: 'connecting',
      reconnectDelayMs: 0,
      errorMessage: null
    });
    expect(state.terminals[0]?.recoveryStatus).toBeUndefined();
    expect(state.workspaceRecovery[0]?.status).toBe('needs-reopen');

    state = appReducer(state, {
      type: 'terminalStatusUpdated',
      terminalId: 'terminal-1',
      state: 'connected',
      reconnectDelayMs: 0,
      errorMessage: null
    });
    expect(state.workspaceRecovery[0]?.status).toBe('restored');
  });

  it('preserves shared group inheritance fields when hydrating web state', () => {
    const group = {
      id: 'group-1',
      name: 'Production',
      sortOrder: 0,
      parentId: 'root',
      defaultIdentityId: 'identity-1',
      connectionProfile: { keepaliveIntervalMs: 5000, reconnect: { enabled: false } }
    };
    const state = appReducer(initialAppState, { type: 'groupsLoaded', groups: [group] });
    expect(state.groups).toEqual([group]);
  });

  it('preserves explicit connection profile overrides in web metadata state', () => {
    const overrides = { keepaliveIntervalMs: 2_000, reconnect: { enabled: false } };
    const state = appReducer(initialAppState, { type: 'hostsLoaded', hosts: [host({ connectionProfileOverrides: overrides })] });

    expect(state.hosts[0]?.connectionProfileOverrides).toEqual(overrides);
  });

  it('opens multiple consoles for the same host and keeps them independent', () => {
    let state = initialAppState;
    state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-1', hostId: 'host-1' });
    state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-2', hostId: 'host-1' });
    state = appReducer(state, {
      type: 'terminalStatusUpdated',
      terminalId: 'tab-1',
      state: 'connected',
      reconnectDelayMs: 0,
      errorMessage: null
    });

    expect(state.terminals).toHaveLength(2);
    expect(state.terminals.find((tab) => tab.terminalId === 'tab-1')?.state).toBe('connected');
    expect(state.terminals.find((tab) => tab.terminalId === 'tab-2')?.state).toBe('closed');
  });

  it('removes only the requested console and activates the adjacent remaining tab', () => {
    let state = initialAppState;
    state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-1', hostId: 'host-1' });
    state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-2', hostId: 'host-1' });
    state = appReducer(state, { type: 'terminalOpened', terminalId: 'tab-3', hostId: 'host-2' });
    state = appReducer(state, { type: 'terminalActivated', terminalId: 'tab-2' });
    state = appReducer(state, { type: 'terminalClosed', terminalId: 'tab-2' });

    expect(state.terminals.map((tab) => tab.terminalId)).toEqual(['tab-1', 'tab-3']);
    expect(state.activeTerminalId).toBe('tab-1');
  });

  it('keeps terminal status values typed as shared protocol statuses', () => {
    const statuses: TerminalStatus[] = ['connecting', 'awaiting-host-key', 'connected', 'reconnecting', 'closed', 'failed'];
    let state = appReducer(initialAppState, { type: 'terminalOpened', terminalId: 'tab-1', hostId: 'host-1' });
    for (const status of statuses) {
      state = appReducer(state, {
        type: 'terminalStatusUpdated',
        terminalId: 'tab-1',
        state: status,
        reconnectDelayMs: status === 'reconnecting' ? 500 : 0,
        errorMessage: status === 'failed' ? '连接失败' : null
      });
    }
    expect(state.terminals[0]).toMatchObject({ state: 'failed', reconnectDelayMs: 0, errorMessage: '连接失败' });
  });
});
