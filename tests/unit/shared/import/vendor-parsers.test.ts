import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseMobaXterm } from '@shared/import/parsers/mobaxterm';
import { parseSecureCrtIni, parseSecureCrtXml } from '@shared/import/parsers/securecrt';
import { parseXshell } from '@shared/import/parsers/xshell';

const read = (name: string): string => readFileSync(resolve('tests/fixtures/import', name), 'utf8');

describe('vendor SSH parsers', () => {
  it('imports MobaXterm SSH sessions and folder paths while skipping non-SSH sessions', () => {
    const document = parseMobaXterm(read('mobaxterm.mxtsessions'), 'mobaxterm.mxtsessions');
    const internal = document.connections.find((connection) => connection.name === 'internal');

    expect(document.connections).toHaveLength(3);
    expect(internal).toMatchObject({
      address: '10.0.0.10',
      port: 22,
      username: 'deploy',
      groupPath: ['Production', 'Internal'],
      jumpHostSourceIds: ['mobaxterm:gateway:bastion.example.com:22:ops']
    });
    expect(document.warnings).toEqual(['mobaxterm.mxtsessions:rdp 不是 SSH/SFTP 会话，已跳过']);
  });

  it('marks Xshell password fields as unreadable and keeps key references', () => {
    const document = parseXshell(read('session.xsh'), 'session.xsh');
    expect(document.connections[0]).toMatchObject({
      address: 'app.example.com',
      port: 2202,
      username: 'deploy',
      authType: 'private_key',
      credentialState: 'needs-source-passphrase',
      identityFile: 'C:\\Users\\deploy\\.ssh\\id_ed25519',
      jumpHostSourceIds: ['xshell:gateway:bastion.example.com:22:ops']
    });
    expect(JSON.stringify(document)).not.toContain('ENCODED_BY_XSHELL');
  });

  it('imports SecureCRT XML and session INI without decrypting passwords', () => {
    const xml = parseSecureCrtXml(read('securecrt.xml'), 'securecrt.xml');
    const ini = parseSecureCrtIni(read('session.ini'), 'db.ini');

    expect(xml.connections[0]).toMatchObject({
      name: 'app',
      address: 'app.example.com',
      groupPath: ['Production'],
      credentialState: 'needs-source-passphrase'
    });
    expect(ini.connections[0]).toMatchObject({
      name: 'db',
      address: 'db.example.com',
      port: 22,
      username: 'dbadmin',
      credentialState: 'needs-source-passphrase',
      identityFile: 'C:\\Keys\\db.key'
    });
    expect(JSON.stringify(xml)).not.toContain('ENCRYPTED_BY_SECURECRT');
  });

  it('reads SecureCRT SSH2 port fields and session folder paths', () => {
    const document = parseSecureCrtIni([
      'S:"Protocol Name"=SSH2',
      'S:"Hostname"=db.example.com',
      'D:"[SSH2] Port"=000008AE',
      'S:"Username"=dbadmin'
    ].join('\n'), 'Sessions/Production/db.ini');

    expect(document.connections[0]).toMatchObject({
      name: 'db',
      address: 'db.example.com',
      port: 2222,
      groupPath: ['Production']
    });
  });
});
