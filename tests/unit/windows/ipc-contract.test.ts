import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import {
  DESKTOP_IPC_MAX_HANDLERS,
  DesktopIpcRouter,
  encodeDesktopIpcRequest,
  parseDesktopIpcRequest
} from '../../../apps/windows/ipc-contract.js';

describe('Windows desktop IPC contract', () => {
  it('accepts only versioned allowlisted operations with bounded payloads', () => {
    expect(encodeDesktopIpcRequest({ version: 1, requestId: 'request-1', operation: 'vault.status', payload: {} })).toEqual({
      version: 1,
      requestId: 'request-1',
      operation: 'vault.status',
      payload: {}
    });
    expect(() => parseDesktopIpcRequest({ version: 1, requestId: 'request-1', operation: 'process.exec', payload: {} })).toThrow('operation not allowed');
    expect(() => parseDesktopIpcRequest({ version: 1, requestId: 'request-1', operation: 'vault.status', payload: {}, extra: true })).toThrow('invalid desktop IPC request');
    expect(() => parseDesktopIpcRequest({ version: 1, requestId: 'request-1', operation: 'vault.setup', payload: { masterPassword: 'x'.repeat(4_097) } })).toThrow('invalid desktop IPC request');
  });

  it('accepts terminal trust and credential decisions as bounded operations', () => {
    expect(encodeDesktopIpcRequest({
      version: 1,
      requestId: 'request-2',
      operation: 'sessions.hostKeyDecision',
      payload: { sessionId: 'session-1', decision: 'trust', fingerprint: 'SHA256:abc' }
    })).toMatchObject({ operation: 'sessions.hostKeyDecision' });
    expect(encodeDesktopIpcRequest({
      version: 1,
      requestId: 'request-3',
      operation: 'sessions.credential',
      payload: { sessionId: 'session-1', hostId: 'host-1', credential: { type: 'password', password: 'secret' } }
    })).toMatchObject({ operation: 'sessions.credential' });
    expect(() => parseDesktopIpcRequest({
      version: 1,
      requestId: 'request-4',
      operation: 'sessions.hostKeyDecision',
      payload: { sessionId: 'session-1', decision: 'trust', fingerprint: 'not-a-fingerprint' }
    })).toThrow('invalid desktop IPC request');
  });

  it('rejects local filesystem paths and unknown handler registration', () => {
    expect(() => parseDesktopIpcRequest({ version: 1, requestId: 'request-1', operation: 'files.list', payload: { hostId: 'host-1', path: 'C:\\secret.txt' } })).toThrow('invalid desktop IPC request');
    expect(() => parseDesktopIpcRequest({ version: 1, requestId: 'request-1', operation: 'files.list', payload: { hostId: 'host-1', path: '/var/log' } })).not.toThrow();
    const router = new DesktopIpcRouter();
    router.register('vault.status', async () => ({ phase: 'locked' }));
    expect(() => router.register('process.exec' as never, async () => undefined)).toThrow('operation not allowed');
    expect(router.handlerCount).toBe(1);
    expect(router.handlerLimit).toBe(DESKTOP_IPC_MAX_HANDLERS);
  });

  it('maps handler failures to stable errors and keeps request ids isolated', async () => {
    const router = new DesktopIpcRouter();
    const handler = vi.fn(async () => { throw new AppError('VAULT_LOCKED'); });
    router.register('vault.status', handler);
    await expect(router.dispatch({ version: 1, requestId: 'request-1', operation: 'vault.status', payload: {} })).resolves.toEqual({
      version: 1,
      requestId: 'request-1',
      ok: false,
      error: { code: 'VAULT_LOCKED', message: 'Vault 已锁定，请先解锁' }
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
