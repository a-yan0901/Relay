import { describe, expect, it } from 'vitest';

import { LiveWorkspaceViewer } from '../../../src/shared/cloud/live-viewer.js';

const snapshot = (epoch = 1) => ({
  protocolVersion: 1 as const,
  type: 'workspace-snapshot' as const,
  workspaceId: 'workspace-1',
  ownerEpoch: epoch,
  sequence: 0,
  terminals: [{ sessionId: 'session-1', hostId: 'host-1', title: 'Shell', status: 'connected' as const, columns: 80, rows: 24, screen: 'prompt$ ' }]
});

describe('bounded live workspace viewer', () => {
  it('requires a resync after a per-terminal sequence gap and resets old output on epoch change', () => {
    const viewer = new LiveWorkspaceViewer({ workspaceId: 'workspace-1', participantDeviceId: 'device-viewer', maxOutputFrames: 2 });
    expect(viewer.apply(snapshot())).toEqual({ status: 'applied' });
    expect(viewer.apply({ protocolVersion: 1, type: 'terminal-output', workspaceId: 'workspace-1', sessionId: 'session-1', ownerEpoch: 1, sequence: 1, payload: 'one' })).toEqual({ status: 'applied', sessionId: 'session-1' });
    expect(viewer.apply({ protocolVersion: 1, type: 'terminal-output', workspaceId: 'workspace-1', sessionId: 'session-1', ownerEpoch: 1, sequence: 3, payload: 'three' })).toEqual({ status: 'resync-required', sessionId: 'session-1', afterSequence: 1 });
    expect(viewer.apply(snapshot(2))).toEqual({ status: 'epoch-changed' });
    expect(viewer.output('session-1')).toEqual([]);
  });

  it('does not resend unacknowledged input and exposes the acknowledgement state', () => {
    const viewer = new LiveWorkspaceViewer({ workspaceId: 'workspace-1', participantDeviceId: 'device-viewer' });
    viewer.apply(snapshot());
    const input = viewer.createInput('session-1', 'ls\n');
    expect(input.type).toBe('terminal-input');
    expect(viewer.pendingInput(input.inputId)?.status).toBe('pending');
    viewer.apply({ protocolVersion: 1, type: 'input-ack', workspaceId: 'workspace-1', sessionId: 'session-1', inputId: input.inputId, inputSequence: 1, outcome: 'unknown' });
    expect(viewer.pendingInput(input.inputId)?.status).toBe('unknown');
  });
});
