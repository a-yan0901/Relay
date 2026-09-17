import { describe, expect, it } from 'vitest';

import { LiveWorkspaceState } from '../../../src/shared/cloud/live-state.js';

describe('bounded live workspace state', () => {
  it('keeps screen snapshots and replays only the bounded output window', () => {
    const state = new LiveWorkspaceState({ workspaceId: 'workspace-1', maxOutputBytes: 2 * 64 * 1024, maxOutputFrames: 2 });
    state.setTerminal({ sessionId: 'session-1', hostId: 'host-1', title: 'Shell', status: 'connected', columns: 80, rows: 24, screen: 'prompt$ ' });
    expect(state.snapshot()).toMatchObject({ type: 'workspace-snapshot', ownerEpoch: 1, terminals: [{ screen: 'prompt$ ' }] });
    state.recordOutput('session-1', 'one');
    state.recordOutput('session-1', 'two');
    state.recordOutput('session-1', 'three');

    expect(state.replay('session-1', 1)).toHaveLength(2);
    expect(state.replay('session-1', 0)).toBeNull();
  });

  it('deduplicates concurrent input and clears old output on owner epoch change', () => {
    const state = new LiveWorkspaceState({ workspaceId: 'workspace-1', maxOutputFrames: 2 });
    const input = { sessionId: 'session-1', participantDeviceId: 'device-1', inputId: 'input-1', payload: 'ls\n' };
    const accepted = state.acceptInput(input);
    expect(accepted.status).toBe('accepted');
    expect(state.acceptInput(input).status).toBe('duplicate');
    state.recordOutput('session-1', 'output');
    state.setOwnerEpoch(2);
    expect(state.snapshot()).toMatchObject({ ownerEpoch: 2 });
    expect(state.replay('session-1', 0)).toEqual([]);
    expect(state.inputAck(input, accepted)).toMatchObject({ type: 'input-ack', inputSequence: 1, outcome: 'accepted' });
  });
});
