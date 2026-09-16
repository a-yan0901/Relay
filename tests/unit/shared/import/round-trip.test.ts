import { describe, expect, it } from 'vitest';

import { exportGenericCsv, exportOpenSshConfig } from '@shared/import/export';
import { resolveImportConnections } from '@shared/import/dedupe';
import { parseSshCsv } from '@shared/import/parsers/csv';
import { parseOpenSshConfig } from '@shared/import/parsers/openssh';
import type { ImportedConnection } from '@shared/import/types';

const source: ImportedConnection[] = [
  {
    sourceId: 'source:bastion', name: 'bastion', address: 'bastion.example.com', port: 2200, username: 'ops', authType: 'private_key', credentialState: 'reference-only', identityFile: '~/.ssh/id_ed25519', groupPath: ['prod'], tags: [], jumpHostSourceIds: [], notes: [], sourceFields: {}
  },
  {
    sourceId: 'source:app', name: 'app', address: 'app.example.com', port: 22, username: 'deploy', authType: 'password', credentialState: 'ready', groupPath: ['prod'], tags: ['web'], jumpHostSourceIds: ['source:bastion'], notes: [], sourceFields: {}
  }
];

describe('standard exchange round trips', () => {
  it('keeps OpenSSH connection fields through parse and export', () => {
    const parsed = parseOpenSshConfig(exportOpenSshConfig(source), 'config');
    expect(parsed.connections).toMatchObject([
      { name: 'bastion', address: 'bastion.example.com', port: 2200, username: 'ops', identityFile: '~/.ssh/id_ed25519' },
      { name: 'app', address: 'app.example.com', port: 22, username: 'deploy', jumpHostSourceIds: ['openssh:bastion'] }
    ]);
  });

  it('keeps CSV metadata through parse and export, with password redaction by default', () => {
    const parsed = parseSshCsv(exportGenericCsv(source), 'connections.csv');
    expect(parsed.connections).toMatchObject([
      { name: 'bastion', address: 'bastion.example.com', groupPath: ['prod'], identityFile: '~/.ssh/id_ed25519' },
      { name: 'app', address: 'app.example.com', tags: ['web'], jumpHostSourceIds: ['csv:bastion'] }
    ]);
  });

  it('resolves exported CSV jump references again without losing group or identity metadata', () => {
    const parsed = parseSshCsv(exportGenericCsv(source), 'connections.csv');
    const resolved = resolveImportConnections(parsed.connections);
    const bastion = resolved.connections.find((connection) => connection.name === 'bastion');
    const app = resolved.connections.find((connection) => connection.name === 'app');

    expect(resolved.conflicts).toEqual([]);
    expect(bastion).toMatchObject({ groupPath: ['prod'], identityFile: '~/.ssh/id_ed25519' });
    expect(app).toMatchObject({ groupPath: ['prod'], tags: ['web'] });
    expect(app?.jumpHostSourceIds).toEqual([bastion?.sourceId]);
  });
});
