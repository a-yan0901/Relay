import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { normalizeWorkspaceState, type WorkspaceState } from '../../../src/shared/core/models.js';
import { WorkspaceRepository } from '../../../src/server/workspace/workspace-repository.js';
import { WorkspaceService } from '../../../src/server/workspace/workspace-service.js';
import { HostRepository } from '../../../src/server/db/repositories.js';
import { migrate } from '../../../src/server/db/migrations.js';

const createDatabase = (): Database.Database => {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  migrate(database);
  return database;
};

const validState = (overrides: Partial<WorkspaceState> = {}): WorkspaceState => ({
  version: 0,
  tabs: [{ id: 'tab-1', hostId: 'host-1', title: 'Production' }],
  activeTabId: 'tab-1',
  layout: { mode: 'vertical', ratio: 0.5 },
  filters: { query: '', groupId: null, favoriteOnly: false },
  ...overrides
});

const addHost = (hosts: HostRepository): void => {
  hosts.createHost({
    id: 'host-1',
    ownerId: 'default',
    name: 'Production',
    address: '10.0.0.8',
    port: 22,
    username: 'ops',
    authType: 'password',
    credentialCiphertext: JSON.stringify({ version: 1, nonce: 'n', ciphertext: 'c', authTag: 't', aad: 'a' }),
    credentialVersion: 1,
    hostKeyAlgorithm: null,
    hostKeyFingerprint: null,
    groupId: null,
    tags: [],
    isFavorite: false,
    lastConnectedAt: null
  });
};

describe('WorkspaceService', () => {
  it('loads a safe default workspace and persists versions optimistically', () => {
    const database = createDatabase();
    const hosts = new HostRepository(database, 'default');
    addHost(hosts);
    const service = new WorkspaceService(new WorkspaceRepository(database));

    expect(service.load('default')).toEqual(expect.objectContaining({
      version: 0,
      tabs: [],
      activeTabId: null,
      layout: { mode: 'single', ratio: 0.5 }
    }));

    const saved = service.save('default', 0, validState());
    expect(saved.version).toBe(1);
    expect(service.load('default')).toEqual(validState({ version: 1 }));
    expect(() => service.save('default', 0, validState())).toThrowError(/工作区已被其他操作更新|WORKSPACE_VERSION_CONFLICT/);
    database.close();
  });

  it('retains tabs for deleted hosts while rejecting invalid ratios', () => {
    const database = createDatabase();
    const service = new WorkspaceService(new WorkspaceRepository(database));

    expect(service.save('default', 0, validState()).state.tabs).toEqual(validState().tabs);
    expect(() => service.save('default', 0, validState({ layout: { mode: 'single', ratio: 0.1 } })))
      .toThrowError(/工作区数据无效|WORKSPACE_INVALID/);
    database.close();
  });

  it('never persists credential or live session fields', () => {
    const database = createDatabase();
    const hosts = new HostRepository(database, 'default');
    addHost(hosts);
    const service = new WorkspaceService(new WorkspaceRepository(database));
    const unsafe = {
      ...validState(),
      password: 'secret',
      terminalId: 'terminal-secret'
    } as unknown as WorkspaceState;

    expect(() => service.save('default', 0, unsafe)).toThrowError(/工作区数据无效|WORKSPACE_INVALID/);
    expect(database.prepare('SELECT COUNT(*) AS count FROM workspace_snapshots').get()).toEqual({ count: 0 });
    database.close();
  });

  it('normalizes an accepted workspace without mutating the caller', () => {
    const state = validState();
    const normalized = normalizeWorkspaceState(state);
    expect(normalized).not.toBe(state);
    expect(normalized.layout).not.toBe(state.layout);
    expect(normalized.layout.ratio).toBe(0.5);
  });
});
