import { describe, expect, it, vi } from 'vitest';

import { AppError } from '../../../src/shared/errors.js';
import type { NotificationPermission } from '../../../src/shared/core/ports.js';
import {
  createBrowserSystemServices,
  detectBrowserSystemCapabilities,
  type BrowserSystemHosts
} from '../../../src/web/platform/browser-system-services.js';

const createHosts = (overrides: Partial<BrowserSystemHosts> = {}): BrowserSystemHosts => ({
  secureContext: true,
  clipboard: {
    readText: vi.fn(async () => 'clipboard text'),
    writeText: vi.fn(async () => undefined)
  },
  notifications: {
    permission: 'default',
    requestPermission: vi.fn(async () => 'granted' as NotificationPermission),
    create: vi.fn()
  },
  ...overrides
});

describe('browser system services', () => {
  it('detects secure clipboard methods and notification support', () => {
    const hosts = createHosts();

    expect(detectBrowserSystemCapabilities(hosts)).toEqual({
      clipboardRead: true,
      clipboardWrite: true,
      notifications: true,
      fileSave: false
    });
  });

  it('reports unsupported clipboard APIs outside a secure context', async () => {
    const hosts = createHosts({ secureContext: false });
    const services = createBrowserSystemServices(hosts);

    expect(services.capabilities.clipboardRead).toBe(false);
    expect(services.capabilities.clipboardWrite).toBe(false);
    await expect(services.clipboard?.readText()).rejects.toEqual(expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }));
    await expect(services.clipboard?.writeText('text')).rejects.toEqual(expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }));
  });

  it('keeps copy available on insecure origins when legacy copy exists', async () => {
    const legacyCopy = vi.fn(() => true);
    const services = createBrowserSystemServices({
      secureContext: false,
      clipboard: {
        readText: vi.fn(async () => 'not readable'),
        writeText: vi.fn(async () => undefined)
      },
      legacyCopy
    });

    expect(services.capabilities).toEqual(expect.objectContaining({ clipboardRead: false, clipboardWrite: true }));
    expect(services.clipboard?.canRead).toBe(false);
    expect(services.clipboard?.canWrite).toBe(true);
    await services.clipboard?.writeText('selected output');
    expect(legacyCopy).toHaveBeenCalledWith('selected output');
    await expect(services.clipboard?.readText()).rejects.toMatchObject({ code: 'CAPABILITY_UNAVAILABLE' });
  });

  it('falls back to legacy copy when native clipboard write is rejected', async () => {
    const legacyCopy = vi.fn(() => true);
    const services = createBrowserSystemServices(createHosts({
      clipboard: {
        readText: vi.fn(async () => 'clipboard text'),
        writeText: vi.fn(async () => { throw new Error('browser denied'); })
      },
      legacyCopy
    }));

    await services.clipboard?.writeText('fallback text');

    expect(legacyCopy).toHaveBeenCalledWith('fallback text');
  });

  it('maps an unsuccessful legacy copy to a stable capability error', async () => {
    const services = createBrowserSystemServices({
      secureContext: false,
      legacyCopy: vi.fn(() => false)
    });

    await expect(services.clipboard?.writeText('text')).rejects.toEqual(expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }));
  });

  it('does not create a notification before permission is granted', async () => {
    const hosts = createHosts();
    const services = createBrowserSystemServices(hosts);

    await expect(services.notifications?.notify({ title: 'Relay', body: 'Task finished' })).rejects.toEqual(expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }));
    expect(hosts.notifications?.create).not.toHaveBeenCalled();

    await expect(services.notifications?.requestPermission()).resolves.toBe('granted');
    if (hosts.notifications) hosts.notifications.permission = 'granted';
    await services.notifications?.notify({ title: 'Relay', body: 'Task finished', tag: 'task-1' });

    expect(hosts.notifications?.create).toHaveBeenCalledWith({ title: 'Relay', body: 'Task finished', tag: 'task-1' });
  });

  it('maps browser rejection to a stable capability error', async () => {
    const hosts = createHosts({
      clipboard: {
        readText: vi.fn(async () => { throw new Error('browser denied'); }),
        writeText: vi.fn(async () => { throw new Error('browser denied'); })
      }
    });
    const services = createBrowserSystemServices(hosts);

    await expect(services.clipboard?.readText()).rejects.toBeInstanceOf(AppError);
    await expect(services.clipboard?.readText()).rejects.toEqual(expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }));
    await expect(services.clipboard?.writeText('text')).rejects.toEqual(expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }));
  });

  it('passes encrypted export bytes to the injected file host', async () => {
    const save = vi.fn(async () => undefined);
    const services = createBrowserSystemServices(createHosts({ fileSave: { save } }));
    const request = { name: 'relay-sync-conflict-conflict-1.json', content: new TextEncoder().encode('{"format":"relay-sync-conflict"}'), mimeType: 'application/json;charset=utf-8' };

    await services.fileSave?.save(request);

    expect(save).toHaveBeenCalledWith(request);
    expect(detectBrowserSystemCapabilities(createHosts({ fileSave: { save } })).fileSave).toBe(true);
  });

  it('maps a rejected file host to a stable capability error', async () => {
    const services = createBrowserSystemServices(createHosts({ fileSave: { save: vi.fn(async () => { throw new Error('browser denied'); }) } }));

    await expect(services.fileSave?.save({ name: 'export.json', content: new Uint8Array([1]), mimeType: 'application/json' })).rejects.toEqual(expect.objectContaining({ code: 'CAPABILITY_UNAVAILABLE' }));
  });

  it('passes an already-redacted notification request through unchanged', async () => {
    const hosts = createHosts({ notifications: {
      permission: 'granted',
      requestPermission: vi.fn(async () => 'granted' as NotificationPermission),
      create: vi.fn()
    } });
    const services = createBrowserSystemServices(hosts);
    const request = { title: 'Relay', body: '任务已完成，请回到 Relay 查看', tag: 'command-run' };

    await services.notifications?.notify(request);

    expect(hosts.notifications?.create).toHaveBeenCalledWith(request);
  });
});
