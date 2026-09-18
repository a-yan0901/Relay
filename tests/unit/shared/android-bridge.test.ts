import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import { createAndroidNativeBridge, type AndroidNativePlugin } from '../../../src/web/platform/android-bridge.js';

describe('Android native bridge', () => {
  it('correlates versioned calls and maps native errors', async () => {
    const plugin: AndroidNativePlugin = {
      invoke: vi.fn(async (frame) => ({ version: 1 as const, requestId: frame.requestId, ok: true as const, result: { phase: 'locked' } })) ,
      addListener: vi.fn(async () => ({ remove: vi.fn() }))
    };
    const bridge = createAndroidNativeBridge(plugin);
    await expect(bridge.invoke('vault.status', {})).resolves.toEqual({ phase: 'locked' });
    expect(plugin.invoke).toHaveBeenCalledWith(expect.objectContaining({ version: 1, operation: 'vault.status' }));

    const failing: AndroidNativePlugin = {
      invoke: vi.fn(async (frame) => ({ version: 1 as const, requestId: frame.requestId, ok: false as const, error: { code: 'VAULT_LOCKED', message: 'locked' } })),
      addListener: vi.fn(async () => ({ remove: vi.fn() }))
    };
    await expect(createAndroidNativeBridge(failing).invoke('vault.status', {})).rejects.toBeInstanceOf(AppError);
  });

  it('installs one event listener, drops duplicates, and bounds subscribers', async () => {
    let emit: ((value: unknown) => void) | undefined;
    const remove = vi.fn();
    const plugin: AndroidNativePlugin = {
      invoke: vi.fn(async (frame) => ({ version: 1 as const, requestId: frame.requestId, ok: true as const, result: undefined })),
      addListener: vi.fn((_name, listener) => { emit = listener; return { remove }; })
    };
    const bridge = createAndroidNativeBridge(plugin, { maxSubscribers: 1 });
    const first = vi.fn();
    const unsubscribe = bridge.subscribe(first);
    await bridge.invoke('vault.status', {});
    await expect(Promise.resolve()).resolves.toBeUndefined();
    expect(plugin.addListener).toHaveBeenCalledTimes(1);
    const event = { version: 1, generation: 1, sequence: 1, kind: 'terminal.output', sessionId: 'session-1', payload: { data: 'ok' } };
    emit?.(event);
    emit?.(event);
    expect(first).toHaveBeenCalledTimes(1);
    expect(() => bridge.subscribe(() => undefined)).toThrow('android native subscriber limit reached');
    unsubscribe();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('starts a fresh event sequence baseline when native subscriptions are recreated', async () => {
    let emit: ((value: unknown) => void) | undefined;
    const plugin: AndroidNativePlugin = {
      invoke: vi.fn(async (frame) => ({ version: 1 as const, requestId: frame.requestId, ok: true as const, result: undefined })),
      addListener: vi.fn((_name, listener) => {
        emit = listener;
        return { remove: vi.fn() };
      })
    };
    const bridge = createAndroidNativeBridge(plugin);
    const first = vi.fn();
    const unsubscribe = bridge.subscribe(first);
    await bridge.invoke('vault.status', {});
    const initialEvent = { version: 1, generation: 1, sequence: 1, kind: 'terminal.status', sessionId: 'session-1', payload: { state: 'connected' } };
    emit?.(initialEvent);
    expect(first).toHaveBeenCalledWith(initialEvent);

    unsubscribe();
    const second = vi.fn();
    bridge.subscribe(second);
    await bridge.invoke('vault.status', {});
    const eventAfterGap = { ...initialEvent, sequence: 3, payload: { state: 'connected' } };
    emit?.(eventAfterGap);

    expect(second).toHaveBeenCalledWith(eventAfterGap);
  });

  it('waits for a native session close before opening the next shell', async () => {
    let releaseClose!: () => void;
    let closeStarted!: () => void;
    const closeFinished = new Promise<void>((resolve) => { releaseClose = resolve; });
    const closeStartedPromise = new Promise<void>((resolve) => { closeStarted = resolve; });
    const operations: string[] = [];
    const plugin: AndroidNativePlugin = {
      invoke: vi.fn(async (frame) => {
        operations.push(frame.operation);
        if (frame.operation === 'sessions.close') {
          closeStarted();
          await closeFinished;
        }
        return {
          version: 1 as const,
          requestId: frame.requestId,
          ok: true as const,
          result: frame.operation === 'sessions.openShell' ? { sessionId: 'new-session' } : undefined
        };
      }),
      addListener: vi.fn(async () => ({ remove: vi.fn() }))
    };
    const bridge = createAndroidNativeBridge(plugin);

    const closePromise = bridge.invoke('sessions.close', { sessionId: 'old-session' });
    await closeStartedPromise;
    const openPromise = bridge.invoke('sessions.openShell', {
      request: { requestId: 'new-session', hostId: 'host-1', cols: 80, rows: 24, term: 'xterm-256color' }
    });

    await Promise.resolve();
    expect(operations).toEqual(['sessions.close']);
    releaseClose();
    await expect(closePromise).resolves.toBeUndefined();
    await expect(openPromise).resolves.toEqual({ sessionId: 'new-session' });
    expect(operations).toEqual(['sessions.close', 'sessions.openShell']);
  });
});
