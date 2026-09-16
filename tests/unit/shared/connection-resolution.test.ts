import { describe, expect, it } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import { defaultConnectionProfileSettings, type HostMetadata } from '../../../src/shared/validation.js';
import type { GroupNode } from '../../../src/shared/core/models.js';
import { resolveConnectionConfiguration } from '../../../src/shared/core/connection-resolution.js';

const group = (id: string, parentId: string | null, overrides: Partial<GroupNode> = {}): GroupNode => ({
  id,
  name: id,
  parentId,
  sortOrder: 0,
  defaultIdentityId: null,
  connectionProfile: null,
  ...overrides
});

const host = (overrides: Partial<Pick<HostMetadata, 'groupId' | 'connectionProfile' | 'credentialSource'>> = {}): Pick<HostMetadata, 'groupId' | 'connectionProfile' | 'credentialSource'> => ({
  groupId: null,
  connectionProfile: undefined,
  credentialSource: undefined,
  ...overrides
});

describe('resolveConnectionConfiguration', () => {
  it('merges application defaults, ancestor groups, nearest group, and host overrides', () => {
    const result = resolveConnectionConfiguration(
      host({
        groupId: 'child',
        connectionProfile: { keepaliveIntervalMs: 2_000 }
      }),
      [
        group('root', null, { connectionProfile: { keepaliveCountMax: 9, reconnect: { maxAttempts: 2 } } }),
        group('child', 'root', { connectionProfile: { keepaliveIntervalMs: 4_000, reconnect: { baseDelayMs: 500 } } })
      ]
    );

    expect(result.groupChain.map(({ id }) => id)).toEqual(['root', 'child']);
    expect(result.profile).toEqual({
      ...defaultConnectionProfileSettings(),
      keepaliveIntervalMs: 2_000,
      keepaliveCountMax: 9,
      reconnect: { enabled: true, maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 5_000 }
    });
  });

  it('uses the nearest group identity only when the host has no explicit source', () => {
    const groups = [
      group('root', null, { defaultIdentityId: 'identity-root' }),
      group('child', 'root', { defaultIdentityId: 'identity-child' })
    ];

    expect(resolveConnectionConfiguration(host({ groupId: 'child' }), groups)).toMatchObject({
      identityId: 'identity-child',
      identitySource: 'group'
    });
    expect(resolveConnectionConfiguration(host({ groupId: 'child', credentialSource: { type: 'inline', authType: 'password' } }), groups)).toMatchObject({
      identityId: null,
      identitySource: 'host'
    });
    expect(resolveConnectionConfiguration(host({ groupId: 'child', credentialSource: { type: 'identity', identityId: 'identity-host' } }), groups)).toMatchObject({
      identityId: 'identity-host',
      identitySource: 'host'
    });
  });

  it('uses explicit profile overrides when a host also carries the normalized stored profile', () => {
    const groups = [group('root', null, { connectionProfile: { keepaliveCountMax: 9 } })];
    const normalizedHost = {
      groupId: 'root',
      connectionProfile: defaultConnectionProfileSettings(),
      connectionProfileOverrides: null,
      credentialSource: { type: 'inline' as const, authType: 'password' as const }
    };

    expect(resolveConnectionConfiguration(normalizedHost, groups).profile).toEqual({
      ...defaultConnectionProfileSettings(),
      keepaliveCountMax: 9
    });
    expect(resolveConnectionConfiguration({
      ...normalizedHost,
      connectionProfileOverrides: { keepaliveIntervalMs: 2_000 }
    }, groups).profile).toEqual({
      ...defaultConnectionProfileSettings(),
      keepaliveIntervalMs: 2_000,
      keepaliveCountMax: 9
    });
  });

  it('rejects missing groups, cycles, and trees deeper than eight levels', () => {
    expect(() => resolveConnectionConfiguration(host({ groupId: 'missing' }), [])).toThrowError(new AppError('GROUP_NOT_FOUND'));
    expect(() => resolveConnectionConfiguration(host({ groupId: 'a' }), [group('a', 'b'), group('b', 'a')])).toThrowError(new AppError('GROUP_CYCLE'));

    const deepGroups = Array.from({ length: 9 }, (_, index) => group(`g${index}`, index === 0 ? null : `g${index - 1}`));
    expect(() => resolveConnectionConfiguration(host({ groupId: 'g8' }), deepGroups)).toThrowError(new AppError('GROUP_DEPTH_EXCEEDED'));
  });
});
