import { describe, expect, it, vi } from 'vitest';

import type { NativeOperationPort } from '../../../src/shared/native/core-runtime.js';
import { createNativePlatformServices } from '../../../src/web/platform/native-platform-services.js';

describe('native platform services', () => {
  it('keeps clipboard access behind the native operation port', async () => {
    const invoke = vi.fn(async <T,>(operation: string): Promise<T> => operation === 'system.clipboard.readText' ? 'copied' as T : undefined as T);
    const port: NativeOperationPort = { invoke, subscribe: () => () => undefined };
    const clipboard = createNativePlatformServices(port).clipboard;
    await expect(clipboard?.readText()).resolves.toBe('copied');
    await clipboard?.writeText('paste');
    expect(invoke).toHaveBeenCalledWith('system.clipboard.writeText', { text: 'paste' });
  });
});
