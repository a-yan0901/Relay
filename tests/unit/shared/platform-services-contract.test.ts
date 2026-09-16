import { describe, expect, it } from 'vitest';

import type { CoreRuntime } from '../../../src/shared/core/runtime.js';
import type {
  ClipboardPort,
  NotificationPort,
  PlatformServices
} from '../../../src/shared/core/ports.js';

describe('platform services contract', () => {
  it('keeps clipboard and notification services platform neutral and optional', async () => {
    let clipboardValue = '';
    const clipboard: ClipboardPort = {
      readText: async () => clipboardValue,
      writeText: async (text) => {
        clipboardValue = text;
      }
    };
    const notifications: NotificationPort = {
      permission: async () => 'granted',
      requestPermission: async () => 'granted',
      notify: async () => undefined
    };
    const platformServices: PlatformServices = { clipboard, notifications };
    const runtime: Pick<CoreRuntime, 'platformServices'> = { platformServices };

    await runtime.platformServices?.clipboard?.writeText('safe test text');

    expect(await runtime.platformServices?.clipboard?.readText()).toBe('safe test text');
    expect(await runtime.platformServices?.notifications?.permission()).toBe('granted');
  });

  it('allows a local-only runtime to omit platform services', () => {
    const runtime: Pick<CoreRuntime, 'platformServices'> = {};

    expect(runtime.platformServices).toBeUndefined();
  });
});
