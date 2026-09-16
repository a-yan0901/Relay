import { describe, expect, it } from 'vitest';

import {
  normalizeWorkspaceState,
  validateJumpChain,
  type ConnectionProfile,
  type WorkspaceState
} from '../../../src/shared/core/models.js';
import { connectionProfileSchema, workspaceStateSchema } from '../../../src/shared/validation.js';
import { createCapabilitySet, effectiveMaxPanes } from '../../../src/shared/core/capabilities.js';

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
    const expandedWorkspace = {
      ...workspace(0.5),
      tabs: Array.from({ length: 16 }, (_, index) => ({ id: `tab-${index + 1}`, hostId: `host-${index + 1}` })),
      activeTabId: 'tab-1',
      layout: { mode: 'grid' as const, ratio: 0.5, paneTabIds: Array.from({ length: 16 }, (_, index) => `tab-${index + 1}`) }
    };
    expect(workspaceStateSchema.safeParse(expandedWorkspace).success).toBe(true);
  });

  it('limits visible panes by the negotiated capability and client platform', () => {
    expect(effectiveMaxPanes(createCapabilitySet('web', ['workspace.max-panes'], { maxWorkspacePanes: 16 }), 4)).toBe(4);
    expect(effectiveMaxPanes(createCapabilitySet('desktop', ['workspace.max-panes'], { maxWorkspacePanes: 2 }), 16)).toBe(2);
    expect(effectiveMaxPanes(createCapabilitySet('web', ['workspace.max-panes'], { maxWorkspacePanes: 8 }), 6)).toBe(6);
    expect(effectiveMaxPanes(createCapabilitySet('web', [], { maxWorkspacePanes: 4 }), 4)).toBe(1);
  });
});
