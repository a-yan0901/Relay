import { describe, expect, it } from 'vitest';

import { parseHostCreateInput } from '../../../src/shared/validation.js';

const baseHost = {
  name: 'Production',
  address: '10.0.0.8',
  port: 22,
  username: 'deploy',
  groupId: null,
  jumpHostIds: [],
  tags: [],
  isFavorite: false
};

describe('host credential source validation', () => {
  it('accepts a legacy inline credential and an explicit inline source', () => {
    expect(parseHostCreateInput({
      ...baseHost,
      auth: { type: 'password', password: 'secret' },
      credentialSource: { type: 'inline', authType: 'password' }
    })).toMatchObject({ credentialSource: { type: 'inline', authType: 'password' } });
  });

  it('accepts an identity reference without exposing credential fields', () => {
    const parsed = parseHostCreateInput({
      ...baseHost,
      credentialSource: { type: 'identity', identityId: 'identity-1' }
    });
    expect(parsed).toMatchObject({ credentialSource: { type: 'identity', identityId: 'identity-1' } });
    expect('password' in parsed).toBe(false);
    expect('privateKey' in parsed).toBe(false);
  });

  it('accepts a group-inherited identity without requiring a browser credential payload', () => {
    const parsed = parseHostCreateInput({
      ...baseHost,
      groupId: 'production',
      credentialSource: { type: 'group' }
    });
    expect(parsed).toMatchObject({ groupId: 'production', credentialSource: { type: 'group' } });
    expect('auth' in parsed).toBe(false);
  });

  it('rejects a host with both inline and identity sources', () => {
    expect(() => parseHostCreateInput({
      ...baseHost,
      auth: { type: 'password', password: 'secret' },
      credentialSource: { type: 'identity', identityId: 'identity-1' }
    })).toThrow();
  });

  it('keeps legacy host auth input valid', () => {
    expect(parseHostCreateInput({ ...baseHost, auth: { type: 'password', password: 'secret' } })).toMatchObject({
      auth: { type: 'password', password: 'secret' }
    });
  });

  it('rejects an identity reference with an invalid owner-scoped identifier', () => {
    expect(() => parseHostCreateInput({
      ...baseHost,
      credentialSource: { type: 'identity', identityId: '../other-owner' }
    })).toThrow();
  });
});
