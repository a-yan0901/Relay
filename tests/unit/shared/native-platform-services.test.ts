import { describe, expect, it, vi } from 'vitest';

import type { NativeOperationPort } from '../../../src/shared/native/core-runtime.js';
import { createNativePlatformServices } from '../../../src/web/platform/native-platform-services.js';

describe('native platform services', () => {
  it('keeps clipboard access behind the native operation port', async () => {
    const invoke = vi.fn(async <T,>(operation: string): Promise<T> => {
      if (operation === 'system.clipboard.readText') return 'copied' as T;
      if (operation === 'system.confirm') return { confirmed: true } as T;
      if (operation === 'system.fileSave.open') return { writerId: 'writer-1' } as T;
      if (operation === 'system.notifications.permission' || operation === 'system.notifications.requestPermission') return 'granted' as T;
      return undefined as T;
    });
    const port: NativeOperationPort = { invoke, subscribe: () => () => undefined };
    const services = createNativePlatformServices(port, { notifications: true });
    const clipboard = services.clipboard;
    await expect(clipboard?.readText()).resolves.toBe('copied');
    await clipboard?.writeText('paste');
    await expect(services.dialogs?.confirm('continue?')).resolves.toBe(true);
    await services.externalLinks?.open('https://example.com');
    const writer = await services.fileWriter?.open({ name: 'output.bin', mimeType: 'application/octet-stream' });
    await writer?.write(new Uint8Array([1, 2, 3]));
    await writer?.seek?.(3);
    await writer?.close();
    await expect(services.notifications?.permission()).resolves.toBe('granted');
    await expect(services.notifications?.requestPermission()).resolves.toBe('granted');
    await services.notifications?.notify({ title: 'Relay', body: 'Task finished', tag: 'task-1' });
    expect(invoke).toHaveBeenCalledWith('system.clipboard.writeText', { text: 'paste' });
    expect(invoke).toHaveBeenCalledWith('system.confirm', { message: 'continue?' });
    expect(invoke).toHaveBeenCalledWith('system.openExternal', { url: 'https://example.com/' });
    expect(invoke).toHaveBeenCalledWith('system.fileSave.open', { name: 'output.bin', mimeType: 'application/octet-stream' });
    expect(invoke).toHaveBeenCalledWith('system.fileSave.write', { writerId: 'writer-1', data: 'AQID' });
    expect(invoke).toHaveBeenCalledWith('system.fileSave.seek', { writerId: 'writer-1', position: 3 });
    expect(invoke).toHaveBeenCalledWith('system.fileSave.close', { writerId: 'writer-1' });
    expect(invoke).toHaveBeenCalledWith('system.notifications.permission', {});
    expect(invoke).toHaveBeenCalledWith('system.notifications.requestPermission', {});
    expect(invoke).toHaveBeenCalledWith('system.notifications.notify', { title: 'Relay', body: 'Task finished', tag: 'task-1' });
  });

  it('does not advertise desktop notifications without an explicit native shell capability', () => {
    const port: NativeOperationPort = { invoke: vi.fn(), subscribe: () => () => undefined };
    expect(createNativePlatformServices(port).notifications).toBeUndefined();
  });

  it('keeps user-triggered sharing behind an explicit native shell capability', async () => {
    const invoke = vi.fn(async <T,>(operation: string): Promise<T> => {
      if (operation === 'system.share.open') return { writerId: 'share-1' } as T;
      return undefined as T;
    });
    const port: NativeOperationPort = { invoke, subscribe: () => () => undefined };
    const services = createNativePlatformServices(port, { sharing: true });

    const writer = await services.shareWriter?.open({ name: 'release.apk', mimeType: 'application/vnd.android.package-archive' });
    await writer?.write(new Uint8Array([1, 2, 3]));
    await writer?.close();

    expect(invoke).toHaveBeenCalledWith('system.share.open', { name: 'release.apk', mimeType: 'application/vnd.android.package-archive' });
    expect(invoke).toHaveBeenCalledWith('system.share.write', { writerId: 'share-1', data: 'AQID' });
    expect(invoke).toHaveBeenCalledWith('system.share.close', { writerId: 'share-1' });
  });

  it('does not advertise sharing without an explicit native shell capability', () => {
    const port: NativeOperationPort = { invoke: vi.fn(), subscribe: () => () => undefined };
    expect(createNativePlatformServices(port).shareWriter).toBeUndefined();
  });
});
