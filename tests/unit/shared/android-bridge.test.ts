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
});
