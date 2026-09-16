import { describe, expect, it } from 'vitest';

import { diffCommandOutputs, filterCommandTargets, summarizeCommandTargets } from '../../../src/shared/core/command-results.js';

const targets = [
  { hostId: 'host-1', status: 'completed' as const, exitCode: 0, output: 'version=1\nready', outputBytes: 15, truncated: true },
  { hostId: 'host-2', status: 'failed' as const, exitCode: 7, output: 'version=2', outputBytes: 9, errorCode: 'COMMAND_RUN_TARGET_FAILED' },
  { hostId: 'host-3', status: 'cancelled' as const, exitCode: null, output: '', outputBytes: 0, errorCode: 'COMMAND_RUN_CANCELLED' }
];

describe('command result model', () => {
  it('summarizes independent target outcomes and anomalies', () => {
    expect(summarizeCommandTargets(targets)).toEqual({
      total: 3,
      queued: 0,
      running: 0,
      completed: 1,
      failed: 1,
      cancelled: 1,
      interrupted: 0,
      anomalyCount: 2,
      truncatedCount: 1
    });
  });

  it('filters by searchable host label, status, and error code without merging targets', () => {
    expect(filterCommandTargets(targets, {
      query: 'production',
      hostLabels: new Map([['host-1', 'Production API'], ['host-2', 'Staging API']])
    }).map((target) => target.hostId)).toEqual(['host-1']);
    expect(filterCommandTargets(targets, { statuses: ['failed'], errorCode: 'COMMAND_RUN_TARGET_FAILED' })).toEqual([targets[1]]);
  });

  it('creates a bounded line diff only for explicitly selected outputs', () => {
    expect(diffCommandOutputs([
      { hostId: 'host-1', output: 'version=1\nready' },
      { hostId: 'host-2', output: 'version=2\nready' }
    ])).toEqual([{
      referenceHostId: 'host-1',
      targetHostId: 'host-2',
      changed: true,
      lines: [
        { kind: 'removed', text: 'version=1' },
        { kind: 'added', text: 'version=2' },
        { kind: 'same', text: 'ready' }
      ]
    }]);
  });
});
