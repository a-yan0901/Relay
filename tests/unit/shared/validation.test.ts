import { describe, expect, it } from 'vitest';
import { parseHostCreateInput } from '@shared/validation';

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
