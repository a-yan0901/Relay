import { describe, expect, it } from 'vitest';

import { decodeLiveFrame, encodeLiveFrame, parseLiveFrame } from '../../../src/shared/cloud/live-protocol.js';

describe('live console protocol', () => {
  it('round-trips an owner snapshot and keeps terminal status explicit', () => {
    const frame = {
      protocolVersion: 1 as const,
      type: 'workspace-snapshot' as const,
      workspaceId: 'workspace-1',
      ownerEpoch: 3,
      sequence: 10,
      terminals: [{
        sessionId: 'session-1',
        hostId: 'host-1',
        title: 'Production',
        status: 'connected' as const,
        columns: 120,
        rows: 40
      }]
    };

    expect(decodeLiveFrame(encodeLiveFrame(frame))).toEqual(frame);
    expect(parseLiveFrame({ ...frame, terminals: [{ ...frame.terminals[0], status: 'needs-reopen' }] }).terminals[0]?.status).toBe('needs-reopen');
  });

  it('rejects oversized output, invalid dimensions, and plaintext extension fields', () => {
    const output = {
      protocolVersion: 1,
      type: 'terminal-output',
      workspaceId: 'workspace-1',
      sessionId: 'session-1',
      ownerEpoch: 1,
      sequence: 1,
      payload: 'x'.repeat(48 * 1024 + 1)
    };
    expect(() => parseLiveFrame(output)).toThrow();
    expect(() => parseLiveFrame({ ...output, payload: 'ok', plaintext: 'secret' })).toThrow();
    expect(() => parseLiveFrame({
      protocolVersion: 1,
      type: 'workspace-snapshot',
      workspaceId: 'workspace-1',
      ownerEpoch: 1,
      sequence: 1,
      terminals: [{ sessionId: 'session-1', hostId: 'host-1', title: 'bad', status: 'connected', columns: 0, rows: 40 }]
    })).toThrow();
    expect(() => parseLiveFrame({
      protocolVersion: 1,
      type: 'workspace-snapshot',
      workspaceId: 'workspace-1',
      ownerEpoch: 1,
      sequence: 1,
      terminals: [{ sessionId: 'session-1', hostId: 'host-1', title: 'unicode', status: 'connected', columns: 80, rows: 24, screen: '界'.repeat(12 * 1024 + 1) }]
    })).toThrow();
  });

  it('does not decode malformed or oversized wire bytes', () => {
    expect(() => decodeLiveFrame(new TextEncoder().encode('{bad'))).toThrow();
    expect(() => decodeLiveFrame(new Uint8Array(64 * 1024 + 1))).toThrow();
  });
});
