import { describe, expect, it } from 'vitest';

import {
  encodeRemoteWorkspaceClientMessage,
  parseRemoteWorkspaceClientMessage,
  parseRemoteWorkspaceServerMessage
} from '../../../src/shared/cloud/remote-wire.js';

const snapshot = {
  protocolVersion: 1 as const,
  type: 'workspace-snapshot' as const,
  workspaceId: 'workspace-1',
  ownerEpoch: 2,
  sequence: 0,
  terminals: []
};

describe('remote workspace local wire', () => {
  it('accepts only bounded input and resync commands', () => {
    expect(encodeRemoteWorkspaceClientMessage({ version: 1, type: 'input', sessionId: 'session-1', inputId: 'input-1', payload: 'ls\n' })).toEqual({
      version: 1,
      type: 'input',
      sessionId: 'session-1',
      inputId: 'input-1',
      payload: 'ls\n'
    });
    expect(parseRemoteWorkspaceClientMessage({ version: 1, type: 'resync', sessionId: 'session-1', afterSequence: 4 })).toEqual({
      version: 1,
      type: 'resync',
      sessionId: 'session-1',
      afterSequence: 4
    });
    expect(() => parseRemoteWorkspaceClientMessage({ version: 1, type: 'input', sessionId: 'session-1', payload: 'x'.repeat(64 * 1024) })).toThrow('invalid remote workspace client message');
  });

  it('rejects unknown fields and invalid server frames', () => {
    expect(() => parseRemoteWorkspaceClientMessage({ version: 1, type: 'close', extra: true })).toThrow('invalid remote workspace client message');
    expect(parseRemoteWorkspaceServerMessage({ version: 1, type: 'frame', frame: snapshot })).toEqual({ version: 1, type: 'frame', frame: snapshot });
    expect(() => parseRemoteWorkspaceServerMessage({ version: 1, type: 'frame', frame: { ...snapshot, workspaceId: '../other' } })).toThrow('invalid remote workspace server message');
  });
});
