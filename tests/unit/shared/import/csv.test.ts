import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseSshCsv } from '@shared/import/parsers/csv';

const fixture = readFileSync(resolve('tests/fixtures/import/ssh.csv'), 'utf8');

describe('generic and Termius CSV parser', () => {
  it('parses reordered aliases, quoted commas, groups, tags, and references', () => {
    const document = parseSshCsv(fixture, 'termius.csv');
    const primary = document.connections[0];

    expect(document.connections).toHaveLength(2);
    expect(primary).toMatchObject({
      name: 'app, primary',
      address: 'app.example.com',
      port: 22,
      username: 'deploy',
      groupPath: ['Production'],
      tags: ['critical', 'web'],
      authType: 'private_key',
      credentialState: 'reference-only',
      identityFile: '~/.ssh/app_ed25519',
      jumpHostSourceIds: ['csv:bastion']
    });
  });

  it('keeps readable passwords internal and reports a ready password state', () => {
    const document = parseSshCsv(fixture, 'export.csv');
    const legacy = document.connections[1];

    expect(legacy.credentialState).toBe('ready');
    expect(legacy.credential).toEqual({ type: 'password', password: 'secret-password' });
  });

  it('understands MobaXterm CSV column names and preserves declared auth type', () => {
    const document = parseSshCsv([
      'Folder name,Session name,Session type,Remote Host,Port number,Username,Key file,Gateway host',
      'Production,app,SSH,app.example.com,2202,deploy,C:\\Keys\\app.ppk,bastion'
    ].join('\n'), 'mobaxterm.csv');

    expect(document.connections[0]).toMatchObject({
      name: 'app',
      address: 'app.example.com',
      port: 2202,
      username: 'deploy',
      identityFile: 'C:\\Keys\\app.ppk',
      groupPath: ['Production'],
      jumpHostSourceIds: ['csv:bastion']
    });
  });

  it('parses Netcatty exports with Hostname/IP and Groups columns', () => {
    const document = parseSshCsv([
      'Groups,Label,Tags,Notes,Hostname/IP,Protocol,Port,Username,Password,KeyPath,Passphrase',
      'Production,app,critical,managed host,app.example.com,ssh,22,deploy,fake-password,,',
    ].join('\r\n'), 'netcatty.csv');

    expect(document.connections).toHaveLength(1);
    expect(document.connections[0]).toMatchObject({
      name: 'app',
      address: 'app.example.com',
      port: 22,
      username: 'deploy',
      groupPath: ['Production'],
      tags: ['critical'],
      credentialState: 'ready'
    });
  });
});
