import { describe, expect, it } from 'vitest';

import {
  normalizeWorkspaceState,
  validateJumpChain,
  type ConnectionProfile,
  type WorkspaceState
} from '../../../src/shared/core/models.js';
import { connectionProfileSchema, workspaceStateSchema } from '../../../src/shared/validation.js';

const profile = (hostId: string, jumpHostIds: string[] = []): ConnectionProfile => ({
  hostId,
  address: `${hostId}.internal`,
  port: 22,
  username: 'ops',
  authType: 'password',
  jumpHostIds,
  keepaliveIntervalMs: 10_000,
  keepaliveCountMax: 3,
  reconnect: { enabled: true, maxAttempts: 5, baseDelayMs: 250, maxDelayMs: 10_000 },
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null
});

const workspace = (ratio: number): WorkspaceState => ({
  version: 1,
  tabs: [{ id: 'tab-1', hostId: 'host-a', title: 'host-a' }],
  activeTabId: 'tab-1',
  layout: { mode: 'vertical', ratio },
  filters: { query: '', groupId: null, favoriteOnly: false }
});

describe('shared core models', () => {
  it('accepts a valid connection profile and rejects more than four jumps', () => {
    expect(connectionProfileSchema.safeParse(profile('host-a')).success).toBe(true);
    expect(connectionProfileSchema.safeParse(profile('host-a', ['h1', 'h2', 'h3', 'h4', 'h5'])).success)
      .toBe(false);
  });

  it('rejects a cyclic jump chain', () => {
    const profiles = new Map([
      ['host-a', profile('host-a', ['host-b'])],
      ['host-b', profile('host-b', ['host-c'])],
      ['host-c', profile('host-c', ['host-a'])]
    ]);

    expect(() => validateJumpChain('host-a', profiles)).toThrow(/cycle/i);
  });

  it('clamps workspace split ratios to the supported range', () => {
    expect(normalizeWorkspaceState(workspace(0.01)).layout.ratio).toBe(0.2);
    expect(normalizeWorkspaceState(workspace(0.99)).layout.ratio).toBe(0.8);
    expect(workspaceStateSchema.safeParse(workspace(0.5)).success).toBe(true);
  });
});
