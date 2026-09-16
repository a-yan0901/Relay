import { AppError } from '../../shared/errors';
import type {
  ClipboardPort,
  FileSavePort,
  FileSaveRequest,
  NotificationPermission as RelayNotificationPermission,
  NotificationPort,
  NotificationRequest,
  PlatformServices
} from '../../shared/core/ports';

export interface BrowserClipboardHost {
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
}

export interface BrowserFileHost {
  save: (request: FileSaveRequest) => Promise<void> | void;
}

export interface BrowserNotificationHost {
  permission: RelayNotificationPermission;
  requestPermission: () => Promise<RelayNotificationPermission>;
  create: (request: NotificationRequest) => void;
}

export interface BrowserSystemHosts {
  secureContext: boolean;
  clipboard?: BrowserClipboardHost;
  fileSave?: BrowserFileHost;
  notifications?: BrowserNotificationHost;
}

export interface BrowserSystemCapabilities {
  clipboardRead: boolean;
  clipboardWrite: boolean;
  fileSave: boolean;
  notifications: boolean;
}

export interface BrowserSystemServices extends PlatformServices {
  capabilities: BrowserSystemCapabilities;
}

const unavailable = (): AppError => new AppError('CAPABILITY_UNAVAILABLE');

const normalizePermission = (value: unknown): RelayNotificationPermission => (
  value === 'granted' || value === 'denied' ? value : 'default'
);

const defaultBrowserSystemHosts = (): BrowserSystemHosts => {
  const browserNavigator = typeof globalThis.navigator === 'undefined' ? undefined : globalThis.navigator;
  const notificationConstructor = typeof globalThis.Notification === 'function' ? globalThis.Notification : undefined;
  const browserDocument = typeof globalThis.document === 'undefined' ? undefined : globalThis.document;
  const browserUrl = typeof globalThis.URL === 'undefined' ? undefined : globalThis.URL;
  const browserBlob = typeof globalThis.Blob === 'function' ? globalThis.Blob : undefined;
  return {
    secureContext: globalThis.isSecureContext !== false,
    clipboard: browserNavigator?.clipboard ? {
      readText: () => browserNavigator.clipboard.readText(),
      writeText: (text: string) => browserNavigator.clipboard.writeText(text)
    } : undefined,
    fileSave: browserDocument && browserUrl && browserBlob && typeof browserUrl.createObjectURL === 'function' ? {
      save: ({ name, content, mimeType }: FileSaveRequest) => {
        const blob = new browserBlob([content.slice().buffer as ArrayBuffer], { type: mimeType });
        const url = browserUrl.createObjectURL(blob);
        const anchor = browserDocument.createElement('a');
        anchor.href = url;
        anchor.download = name;
        anchor.hidden = true;
        (browserDocument.body ?? browserDocument.documentElement).append(anchor);
        anchor.click();
        anchor.remove();
        browserUrl.revokeObjectURL(url);
      }
    } : undefined,
    notifications: notificationConstructor ? {
      get permission() {
        return normalizePermission(notificationConstructor.permission);
      },
      requestPermission: async () => normalizePermission(await notificationConstructor.requestPermission()),
      create: (request) => {
        new notificationConstructor(request.title, {
          body: request.body,
          ...(request.tag === undefined ? {} : { tag: request.tag })
        });
      }
    } : undefined
  };
};

export const detectBrowserSystemCapabilities = (
  hosts: BrowserSystemHosts = defaultBrowserSystemHosts()
): BrowserSystemCapabilities => ({
  clipboardRead: hosts.secureContext && typeof hosts.clipboard?.readText === 'function',
  clipboardWrite: hosts.secureContext && typeof hosts.clipboard?.writeText === 'function',
  fileSave: typeof hosts.fileSave?.save === 'function',
  notifications: hosts.notifications !== undefined
});

const createClipboardPort = (
  hosts: BrowserSystemHosts,
  capabilities: BrowserSystemCapabilities
): ClipboardPort => ({
  async readText(): Promise<string> {
    if (!capabilities.clipboardRead || !hosts.clipboard?.readText) throw unavailable();
    try {
      return await hosts.clipboard.readText();
    } catch {
      throw unavailable();
    }
  },
  async writeText(text: string): Promise<void> {
    if (!capabilities.clipboardWrite || !hosts.clipboard?.writeText) throw unavailable();
    try {
      await hosts.clipboard.writeText(text);
    } catch {
      throw unavailable();
    }
  }
});

const createFileSavePort = (
  hosts: BrowserSystemHosts,
  capabilities: BrowserSystemCapabilities
): FileSavePort => ({
  async save(request: FileSaveRequest): Promise<void> {
    if (!capabilities.fileSave || !hosts.fileSave) throw unavailable();
    try {
      await hosts.fileSave.save(request);
    } catch {
      throw unavailable();
    }
  }
});

const createNotificationPort = (
  hosts: BrowserSystemHosts,
  capabilities: BrowserSystemCapabilities
): NotificationPort => ({
  async permission(): Promise<RelayNotificationPermission> {
    return normalizePermission(hosts.notifications?.permission);
  },
  async requestPermission(): Promise<RelayNotificationPermission> {
    if (!hosts.notifications) return 'denied';
    try {
      return normalizePermission(await hosts.notifications.requestPermission());
    } catch {
      throw unavailable();
    }
  },
  async notify(request: NotificationRequest): Promise<void> {
    if (!capabilities.notifications || !hosts.notifications || await normalizePermission(hosts.notifications.permission) !== 'granted') {
      throw unavailable();
    }
    try {
      hosts.notifications.create(request);
    } catch {
      throw unavailable();
    }
  }
});

export const createBrowserSystemServices = (
  hosts: BrowserSystemHosts = defaultBrowserSystemHosts()
): BrowserSystemServices => {
  const capabilities = detectBrowserSystemCapabilities(hosts);
  return {
    capabilities,
    clipboard: createClipboardPort(hosts, capabilities),
    fileSave: createFileSavePort(hosts, capabilities),
    notifications: createNotificationPort(hosts, capabilities)
  };
};
