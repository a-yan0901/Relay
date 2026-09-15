import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseOpenSshConfig } from '@shared/import/parsers/openssh';

const fixture = readFileSync(resolve('tests/fixtures/import/openssh/config'), 'utf8');

describe('OpenSSH config parser', () => {
  it('imports concrete hosts and ignores wildcard defaults as records', () => {
    const document = parseOpenSshConfig(fixture, 'config');

    expect(document.connections).toHaveLength(3);
    expect(document.connections.map((connection) => connection.name)).toEqual(['bastion', 'app', 'api']);
    expect(document.connections[0]).toMatchObject({
      address: 'bastion.example.com',
      port: 2200,
      username: 'ops',
      authType: 'private_key',
      credentialState: 'reference-only',
      identityFile: '~/.ssh/id_ed25519'
    });
  });

  it('resolves direct jump aliases to stable source references and warns on ProxyCommand', () => {
    const document = parseOpenSshConfig(fixture, 'config');
    const app = document.connections.find((connection) => connection.name === 'app');

    expect(app?.jumpHostSourceIds).toEqual(['openssh:bastion', 'openssh:admin@edge.example.com:2222']);
    expect(app?.notes).toContain('ProxyCommand 未转换为跳板机');
    expect(document.warnings).toContain('config:app 使用了不支持的 ProxyCommand');
  });
});
