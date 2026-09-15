import { describe, expect, it } from 'vitest';

import { exportGenericCsv, exportOpenSshConfig } from '@shared/import/export';
import type { ImportedConnection } from '@shared/import/types';

const connections: ImportedConnection[] = [
  {
    sourceId: 'source:bastion',
    name: 'Bastion Gateway',
    address: 'bastion.example.com',
    port: 2200,
    username: 'ops',
    authType: 'private_key',
    credentialState: 'reference-only',
    identityFile: '~/.ssh/id_ed25519',
    groupPath: ['Production'],
    tags: ['critical', 'edge'],
    jumpHostSourceIds: [],
    notes: [],
    sourceFields: {}
  },
  {
    sourceId: 'source:app',
    name: 'app, primary',
    address: 'app.example.com',
    port: 22,
    username: 'deploy',
    authType: 'password',
    credentialState: 'ready',
    credential: { type: 'password', password: 'secret-not-in-default-output' },
    groupPath: ['Production'],
    tags: ['web'],
    jumpHostSourceIds: ['source:bastion'],
    notes: [],
    sourceFields: {}
  }
];

describe('standard SSH exporters', () => {
  it('exports OpenSSH fields and ProxyJump without passwords', () => {
    const output = exportOpenSshConfig(connections);

    expect(output).toContain('Host app-primary');
    expect(output).toContain('HostName app.example.com');
    expect(output).toContain('User deploy');
    expect(output).toContain('ProxyJump Bastion-Gateway');
    expect(output).not.toContain('secret-not-in-default-output');
  });

  it('exports CSV with escaped values and omits password by default', () => {
    const output = exportGenericCsv(connections);

    expect(output.split('\r\n')[0]).toBe('name,address,port,username,authType,identityFile,group,tags,jumpHosts');
    expect(output).toContain('"app, primary"');
    expect(output).not.toContain('secret-not-in-default-output');
  });

  it('requires explicit confirmation for password export', () => {
    expect(() => exportGenericCsv(connections, { includePasswords: true })).toThrow();
    expect(exportGenericCsv(connections, { includePasswords: true, confirmPasswordExport: true })).toContain('secret-not-in-default-output');
  });
});
