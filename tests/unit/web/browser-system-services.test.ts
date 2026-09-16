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
      notifications: true
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
