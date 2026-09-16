import { describe, expect, it } from 'vitest';

import type { HostMetadataState } from '../../src/web/state/app-state.js';
import { createHostSearchIndex, filterHostsByQuery } from '../../src/web/state/navigation-state.js';

const host = (index: number): HostMetadataState => ({
  id: `host-${index}`,
  name: `production-${index}`,
  address: `10.0.${Math.floor(index / 255)}.${index % 255}`,
  port: 22,
  username: 'ops',
  authType: 'password',
  groupId: null,
  tags: index % 2 === 0 ? ['production'] : ['staging'],
  isFavorite: index % 10 === 0,
  hostKeyAlgorithm: null,
  hostKeyFingerprint: null,
  lastConnectedAt: null,
  createdAt: '2026-09-15T00:00:00.000Z',
  updatedAt: '2026-09-15T00:00:00.000Z'
});

const benchmarkSearch = (hosts: readonly HostMetadataState[], rounds: number): { elapsedMs: number; matches: number } => {
  const searchIndex = createHostSearchIndex(hosts);
  const startedAt = performance.now();
  let matches = 0;
  for (let round = 0; round < rounds; round += 1) {
    matches += filterHostsByQuery(hosts, round % 2 === 0 ? 'production' : '10.0', searchIndex).length;
  }
  return { elapsedMs: performance.now() - startedAt, matches };
};

describe('host vault scale baseline', () => {
  it('keeps 1,000-host search linear and reuses the searchable metadata index', () => {
    const small = benchmarkSearch(Array.from({ length: 100 }, (_, index) => host(index)), 100);
    const large = benchmarkSearch(Array.from({ length: 1_000 }, (_, index) => host(index)), 100);

    expect(large.matches).toBeGreaterThan(small.matches);
    // Relative to the 10x data set, leave a wide margin for CI scheduling and JIT warm-up.
    expect(large.elapsedMs).toBeLessThan(Math.max(small.elapsedMs * 40, 500));
  });
});
