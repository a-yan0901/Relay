import { describe, expect, it } from 'vitest';

import {
  appReducer,
  initialAppState,
  type AppState,
  type HostMetadataState
} from '../../../src/web/state/app-state';

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
      { terminalId: 'tab-1', hostId: 'host-1' },
      { terminalId: 'tab-2', hostId: 'host-2' }
    ]);
    expect(state.activeTerminalId).toBe('tab-2');
  });
});
