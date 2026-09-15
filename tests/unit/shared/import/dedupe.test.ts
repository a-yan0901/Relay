import { describe, expect, it } from 'vitest';

import { resolveImportConnections, stableImportKey } from '@shared/import/dedupe';
import type { ExistingImportHost, ImportedConnection } from '@shared/import/types';

const connection = (overrides: Partial<ImportedConnection> = {}): ImportedConnection => ({
  sourceId: 'source:app',
  name: 'app',
  address: 'APP.example.com',
  port: 22,
  username: 'deploy',
  authType: 'password',
  credentialState: 'ready',
  groupPath: [],
  tags: [],
  jumpHostSourceIds: [],
  notes: [],
  sourceFields: {},
  ...overrides
});

describe('import deduplication and jump resolution', () => {
  it('uses normalized address, port, and username as the stable identity', () => {
    expect(stableImportKey(connection())).toBe('app.example.com|22|deploy');
  });

  it('collapses same-batch duplicates and resolves source/name jump references', () => {
    const result = resolveImportConnections([
      connection({ sourceId: 'source:bastion', name: 'bastion', address: 'bastion.example.com' }),
      connection({ sourceId: 'source:app', jumpHostSourceIds: ['source:bastion'] }),
      connection({ sourceId: 'source:duplicate', name: 'app-copy' })
    ]);

    expect(result.connections.map((item) => item.sourceId)).toEqual(['source:bastion', 'source:app']);
    expect(result.connections[1]?.jumpHostSourceIds).toEqual(['source:bastion']);
    expect(result.conflicts.some((conflict) => conflict.kind === 'same-batch')).toBe(true);
  });

  it('classifies existing host conflicts and unresolved jumps', () => {
    const existing: ExistingImportHost[] = [{
      id: 'host-existing', name: 'existing', address: 'app.example.com', port: 22, username: 'deploy', authType: 'password', groupId: null
    }];
    const result = resolveImportConnections([connection({ jumpHostSourceIds: ['missing'] })], existing);

    expect(result.conflicts).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'existing-host' }),
      expect.objectContaining({ kind: 'unresolved-jump' })
    ]));
    expect(result.connections[0]?.applicable).toBe(false);
  });
});
