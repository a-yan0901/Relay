import { describe, expect, it } from 'vitest';

import {
  initialCommandTargetState,
  initialConnectionState,
  initialTransferState,
  connectionDiagnosticToOperationDiagnostic,
  transitionCommandTarget,
  transitionConnection,
  transitionTransfer
} from '../../../src/shared/core/state-machines.js';

describe('shared core state machines', () => {
  it('moves a connection through resolution, authentication, channel open and connected', () => {
    let state = initialConnectionState();
    state = transitionConnection(state, { type: 'resolve-start' });
    state = transitionConnection(state, { type: 'resolve-complete', hopCount: 0 });
    state = transitionConnection(state, { type: 'transport-start' });
    state = transitionConnection(state, { type: 'host-key-required' });
    state = transitionConnection(state, { type: 'host-key-approved' });
    state = transitionConnection(state, { type: 'authentication-succeeded' });
    state = transitionConnection(state, { type: 'channel-opened' });

    expect(state.state).toBe('connected');
    expect(state.attempt).toBe(0);
  });

  it('allows a transient connection failure to enter reconnecting but not a permanent host-key failure', () => {
    const connecting = transitionConnection(initialConnectionState(), { type: 'resolve-start' });
    const failed = transitionConnection(connecting, {
      type: 'failed',
      code: 'CONNECTION_STAGE_FAILED',
      retryable: true
    });
    expect(transitionConnection(failed, { type: 'retry-scheduled', delayMs: 250 }).state).toBe('reconnecting');

    const rejected = transitionConnection(connecting, {
      type: 'failed',
      code: 'HOST_KEY_MISMATCH',
      retryable: false
    });
    expect(() => transitionConnection(rejected, { type: 'retry-scheduled', delayMs: 250 })).toThrow();
  });

  it('does not permit a completed transfer to run again', () => {
    let state = initialTransferState('transfer-1');
    state = transitionTransfer(state, { type: 'start', totalBytes: 10 });
    state = transitionTransfer(state, { type: 'progress', completedBytes: 10 });
    state = transitionTransfer(state, { type: 'completed' });
    expect(state.status).toBe('completed');
    expect(() => transitionTransfer(state, { type: 'start', totalBytes: 10 })).toThrow();
  });

  it('allows restart reconciliation to mark active transfers interrupted and retry them', () => {
    const interrupted = transitionTransfer({ id: 'transfer-1', status: 'running', completedBytes: 4, totalBytes: 10 }, { type: 'interrupted', code: 'SERVICE_RESTARTED' });
    expect(interrupted).toMatchObject({ status: 'interrupted', completedBytes: 4, errorCode: 'SERVICE_RESTARTED' });
    expect(transitionTransfer(interrupted, { type: 'retry' })).toMatchObject({ status: 'queued', completedBytes: 0 });
  });

  it('does not move a completed command target back to running', () => {
    let state = initialCommandTargetState('host-1');
    state = transitionCommandTarget(state, { type: 'start' });
    state = transitionCommandTarget(state, { type: 'completed', exitCode: 0, outputBytes: 4 });
    expect(state.status).toBe('completed');
    expect(() => transitionCommandTarget(state, { type: 'start' })).toThrow();
  });

  it('maps low-level connection diagnostics to one explainable operation contract', () => {
    expect(connectionDiagnosticToOperationDiagnostic({
      id: 'diagnostic-1',
      hostId: 'host-1',
      stage: 'authentication',
      status: 'failed',
      hopIndex: 0,
      retryable: false,
      code: 'SSH_AUTH_FAILED',
      at: '2026-09-16T00:00:00.000Z'
    }, {
      operationId: 'terminal-1',
      requestId: 'request-1'
    })).toEqual({
      operationId: 'terminal-1',
      hostId: 'host-1',
      kind: 'terminal',
      stage: 'auth',
      state: 'failed',
      retryable: false,
      nextAction: 'edit-credentials',
      errorCode: 'SSH_AUTH_FAILED',
      requestId: 'request-1',
      startedAt: '2026-09-16T00:00:00.000Z',
      endedAt: '2026-09-16T00:00:00.000Z'
    });
  });

  it('keeps an interrupted command target terminal and never restarts it implicitly', () => {
    let state = transitionCommandTarget(initialCommandTargetState('host-1'), { type: 'start' });
    state = transitionCommandTarget(state, { type: 'interrupted', code: 'SERVICE_RESTARTED' });

    expect(state).toMatchObject({ status: 'interrupted', errorCode: 'SERVICE_RESTARTED' });
    expect(() => transitionCommandTarget(state, { type: 'start' })).toThrow();
  });
});
