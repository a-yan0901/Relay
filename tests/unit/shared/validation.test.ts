import { describe, expect, it } from 'vitest';
import { expandCommandTemplate, parseCommandRunRequest, parseHostCreateInput } from '@shared/validation';

const baseHost = {
  name: 'Production API',
  address: '10.0.0.8',
  username: 'deploy',
  auth: { type: 'password', password: 'correct horse battery staple' }
};

describe('parseHostCreateInput', () => {
  it('defaults an omitted SSH port to 22', () => {
    const result = parseHostCreateInput(baseHost);

    expect(result.port).toBe(22);
    expect(result.username).toBe('deploy');
  });

  it.each(['10.0.0.8', '2001:db8::8', 'server.internal.example'])('accepts a host address %s', (address) => {
    expect(parseHostCreateInput({ ...baseHost, address }).address).toBe(address);
  });

  it.each(['https://10.0.0.8', '10.0.0.8; reboot', '10.0.0.8/path', '10.0.0.8?cmd=id', ''])('rejects unsafe address %s', (address) => {
    expect(() => parseHostCreateInput({ ...baseHost, address })).toThrow();
  });

  it.each([0, -1, 65536, 22.5, '22'])('rejects invalid SSH port %s', (port) => {
    expect(() => parseHostCreateInput({ ...baseHost, port })).toThrow();
  });

  it('accepts a private key and optional passphrase', () => {
    const result = parseHostCreateInput({
      ...baseHost,
      auth: {
        type: 'private_key',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
        passphrase: 'key secret'
      }
    });

    expect(result.auth).toEqual({
      type: 'private_key',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nfixture\n-----END OPENSSH PRIVATE KEY-----',
      passphrase: 'key secret'
    });
  });

  it.each([
    { ...baseHost, username: '' },
    { ...baseHost, name: '' },
    { ...baseHost, auth: { type: 'password', password: '' } },
    { ...baseHost, auth: { type: 'unknown', password: 'secret' } }
  ])('rejects incomplete host input', (input) => {
    expect(() => parseHostCreateInput(input)).toThrow();
  });

  it('rejects an oversized private key and more than twenty tags', () => {
    expect(() => parseHostCreateInput({
      ...baseHost,
      auth: { type: 'private_key', privateKey: 'x'.repeat(32769) }
    })).toThrow();

    expect(() => parseHostCreateInput({
      ...baseHost,
      tags: Array.from({ length: 21 }, (_, index) => `tag-${index}`)
    })).toThrow();
  });
});

describe('command run validation', () => {
  it('rejects missing and extra variables before a command can be queued', () => {
    expect(() => expandCommandTemplate('systemctl status {{service}}', {})).toThrow();
    expect(() => expandCommandTemplate('systemctl status {{service}}', { service: 'api', token: 'secret' })).toThrow();
    expect(expandCommandTemplate('systemctl status {{service}}', { service: 'api' })).toBe('systemctl status api');
  });

  it('accepts a fixed target snapshot and rejects mismatched display metadata', () => {
    const request = parseCommandRunRequest({
      command: 'uname -a',
      hostIds: ['host-1', 'host-2'],
      variables: {},
      concurrency: 2,
      timeoutMs: 1_000,
      persistOutput: false,
      targetSelection: {
        hostIds: ['host-1', 'host-2'],
        source: 'workspace',
        capturedAt: '2026-09-16T09:00:00.000Z',
        displayNames: ['Production', 'Staging']
      }
    });
    expect(request.targetSelection?.source).toBe('workspace');
    expect(() => parseCommandRunRequest({
      command: 'uname -a',
      hostIds: ['host-1'],
      variables: {},
      targetSelection: {
        hostIds: ['host-1'],
        source: 'servers',
        capturedAt: '2026-09-16T09:00:00.000Z',
        displayNames: []
      }
    })).toThrow();
  });
});
