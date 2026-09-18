import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import { NativeEventGate, type NativeEventFrame } from '../../../src/shared/native/bridge.js';
import { createDesktopPreloadApi, exposeDesktopPreloadApi, type DesktopIpcTransport } from '../../../apps/windows/preload.js';

const response = (requestId: string, result: unknown) => ({ version: 1 as const, requestId, ok: true as const, result });

describe('Windows desktop preload API', () => {
  it('validates and correlates requests before exposing a narrow API', async () => {
    const transport: DesktopIpcTransport = {
      invoke: vi.fn(async (request) => response(request.requestId, { phase: 'locked' })),
      subscribe: () => () => undefined
    };
    const api = createDesktopPreloadApi(transport);

    await expect(api.invoke('vault.status', {})).resolves.toEqual({ phase: 'locked' });
    expect(transport.invoke).toHaveBeenCalledWith(expect.objectContaining({ operation: 'vault.status' }));
    await expect(api.invoke('process.exec' as never, {})).rejects.toThrow('operation not allowed');
  });

  it('does not accept a response for another request or leak arbitrary errors', async () => {
    const transport: DesktopIpcTransport = {
      invoke: vi.fn(async () => response('other-request', { ok: true })),
      subscribe: () => () => undefined
    };
    const api = createDesktopPreloadApi(transport);

    await expect(api.invoke('vault.status', {})).rejects.toThrow('desktop IPC response mismatch');
    const failing: DesktopIpcTransport = {
      invoke: vi.fn(async (request) => ({ version: 1 as const, requestId: request.requestId, ok: false as const, error: { code: 'VAULT_LOCKED' as const, message: 'Vault 已锁定，请先解锁' } })),
      subscribe: () => () => undefined
    };
    await expect(createDesktopPreloadApi(failing).invoke('vault.status', {})).rejects.toMatchObject({ code: 'VAULT_LOCKED' });
  });

  it('bounds event subscribers and exposes only the named global', () => {
    const listeners = new Set<(event: NativeEventFrame) => void>();
    const bridge: DesktopIpcTransport = {
      invoke: vi.fn(),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
    };
    const api = createDesktopPreloadApi(bridge, { maxSubscribers: 1, eventGate: new NativeEventGate() });
    const first = vi.fn();
    const second = vi.fn();
    const unsubscribe = api.subscribe(first);
    expect(() => api.subscribe(second)).toThrow('desktop IPC subscriber limit reached');
    const event: NativeEventFrame = { version: 1, generation: 1, sequence: 1, kind: 'terminal.output', payload: { text: 'ok' } };
    for (const listener of listeners) listener(event);
    expect(first).toHaveBeenCalledWith(event);
    expect(second).not.toHaveBeenCalled();
    unsubscribe();
    expect(listeners).toHaveLength(0);

    const expose = vi.fn();
    exposeDesktopPreloadApi({ exposeInMainWorld: expose }, api, 'relayDesktop');
    expect(expose).toHaveBeenCalledWith('relayDesktop', api);
    expect(() => exposeDesktopPreloadApi({ exposeInMainWorld: expose }, api, 'bad-key')).toThrow('invalid preload key');
  });

  it('starts a fresh event sequence baseline when renderer subscriptions are recreated', () => {
    const listeners = new Set<(event: NativeEventFrame) => void>();
    const transport: DesktopIpcTransport = {
      invoke: vi.fn(),
      subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
    };
    const api = createDesktopPreloadApi(transport);
    const first = vi.fn();
    const unsubscribe = api.subscribe(first);
    const initialEvent: NativeEventFrame = { version: 1, generation: 1, sequence: 1, kind: 'terminal.status', sessionId: 'session-1', payload: { state: 'connected' } };
    for (const listener of listeners) listener(initialEvent);
    expect(first).toHaveBeenCalledWith(initialEvent);
    unsubscribe();

    const second = vi.fn();
    api.subscribe(second);
    const eventAfterGap = { ...initialEvent, sequence: 3 };
    for (const listener of listeners) listener(eventAfterGap);

    expect(second).toHaveBeenCalledWith(eventAfterGap);
  });

  it('preserves stable application errors from the main process', async () => {
    const transport: DesktopIpcTransport = {
      invoke: vi.fn(async (request) => ({ version: 1 as const, requestId: request.requestId, ok: false as const, error: { code: 'VAULT_LOCKED' as const, message: 'locked' } })),
      subscribe: () => () => undefined
    };
    await expect(createDesktopPreloadApi(transport).invoke('vault.status', {})).rejects.toBeInstanceOf(AppError);
  });

  it('serializes native session close before opening the next shell', async () => {
    const operations: string[] = [];
    let releaseClose!: () => void;
    const closeReleased = new Promise<void>((resolve) => { releaseClose = resolve; });
    const transport: DesktopIpcTransport = {
      invoke: vi.fn(async (request) => {
        operations.push(request.operation);
        if (request.operation === 'sessions.close') await closeReleased;
        return response(request.requestId, request.operation === 'sessions.openShell' ? { sessionId: 'next-session' } : undefined);
      }),
      subscribe: () => () => undefined
    };
    const api = createDesktopPreloadApi(transport);

    const closePromise = api.invoke('sessions.close', { sessionId: 'old-session' });
    await vi.waitFor(() => expect(operations).toEqual(['sessions.close']));
    const openPromise = api.invoke('sessions.openShell', { request: { requestId: 'next-session', hostId: 'host-1', cols: 80, rows: 24 } });
    await Promise.resolve();
    expect(operations).toEqual(['sessions.close']);

    releaseClose();
    await expect(closePromise).resolves.toBeUndefined();
    await expect(openPromise).resolves.toEqual({ sessionId: 'next-session' });
    expect(operations).toEqual(['sessions.close', 'sessions.openShell']);
  });
});
