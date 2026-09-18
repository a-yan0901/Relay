import { AppError } from '../../shared/errors';
import type {
  ClipboardPort,
  DialogPort,
  DownloadPort,
  DownloadRequest,
  ExternalLinkPort,
  FileSavePort,
  FileSaveRequest,
  FileWriter,
  FileWriterPort,
  NotificationPermission as RelayNotificationPermission,
  NotificationPort,
  NotificationRequest,
  PlatformServices,
  StoragePort
} from '../../shared/core/ports';

export interface BrowserClipboardHost {
  readText?: () => Promise<string>;
  writeText?: (text: string) => Promise<void>;
}

export interface BrowserFileHost {
  save: (request: FileSaveRequest) => Promise<void> | void;
}

export interface BrowserFileWriterHost {
  open: (request: Pick<FileSaveRequest, 'name' | 'mimeType'>) => Promise<FileWriter | null>;
}

export interface BrowserNotificationHost {
  permission: RelayNotificationPermission;
  requestPermission: () => Promise<RelayNotificationPermission>;
  create: (request: NotificationRequest) => void;
}

export interface BrowserSystemHosts {
  secureContext: boolean;
  preferences?: StoragePort;
  session?: StoragePort;
  clipboard?: BrowserClipboardHost;
  confirm?: (message: string) => boolean | Promise<boolean>;
  openExternal?: (url: string) => void | Promise<void>;
  legacyCopy?: (text: string) => boolean | void;
  download?: (request: DownloadRequest) => void | Promise<void>;
  fileSave?: BrowserFileHost;
  fileWriter?: BrowserFileWriterHost;
  notifications?: BrowserNotificationHost;
}

export interface BrowserSystemCapabilities {
  clipboardRead: boolean;
  clipboardWrite: boolean;
  dialogs: boolean;
  externalLinks: boolean;
  fileSave: boolean;
  fileWriter: boolean;
  downloads: boolean;
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
  const browserPreferences = (() => {
    try { return globalThis.localStorage as StoragePort; } catch { return undefined; }
  })();
  const browserSession = (() => {
    try { return globalThis.sessionStorage as StoragePort; } catch { return undefined; }
  })();
  const browserFilePicker = (globalThis as typeof globalThis & {
    showSaveFilePicker?: (options?: { suggestedName?: string; types?: Array<{ accept: Record<string, string[]> }> }) => Promise<{
      createWritable(): Promise<{
        write(data: Uint8Array): Promise<void>;
        seek(position: number): Promise<void>;
        close(): Promise<void>;
        abort?: () => Promise<void>;
      }>;
    }>;
  }).showSaveFilePicker;
  const legacyCopy = browserDocument && typeof browserDocument.execCommand === 'function'
    ? (text: string): boolean => {
      const parent = browserDocument.body ?? browserDocument.documentElement;
      if (!parent) return false;
      const previousActiveElement = browserDocument.activeElement as HTMLElement | null;
      const selection = browserDocument.getSelection?.();
      const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
      const textarea = browserDocument.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '-9999px';
      textarea.style.opacity = '0';
      parent.append(textarea);
      textarea.focus();
      textarea.select();
      const copied = (() => {
        try {
          return browserDocument.execCommand('copy');
        } catch {
          return false;
        }
      })();
      textarea.remove();
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
      try { previousActiveElement?.focus(); } catch { /* focus restoration is best effort */ }
      return copied;
    }
    : undefined;
  return {
    secureContext: globalThis.isSecureContext !== false,
    preferences: browserPreferences,
    session: browserSession,
    clipboard: browserNavigator?.clipboard ? {
      readText: () => browserNavigator.clipboard.readText(),
      writeText: (text: string) => browserNavigator.clipboard.writeText(text)
    } : undefined,
    confirm: typeof globalThis.confirm === 'function' ? (message: string) => globalThis.confirm(message) : undefined,
    openExternal: typeof globalThis.open === 'function' ? (url: string) => {
      globalThis.open(url, '_blank', 'noopener,noreferrer');
    } : undefined,
    download: browserDocument ? ({ url, name }: DownloadRequest) => {
      const anchor = browserDocument.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.hidden = true;
      (browserDocument.body ?? browserDocument.documentElement).append(anchor);
      anchor.click();
      anchor.remove();
    } : undefined,
    legacyCopy,
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
    fileWriter: browserFilePicker ? {
      open: async ({ name, mimeType }) => {
        try {
          const handle = await browserFilePicker({
            suggestedName: name,
            types: [{ accept: { [mimeType]: ['.json', '.txt', '.bin'] } }]
          });
          const writable = await handle.createWritable();
          const writer: FileWriter = {
            write: (data) => writable.write(data),
            seek: (position) => writable.seek(position),
            close: () => writable.close(),
            ...(writable.abort ? { cancel: () => writable.abort?.() ?? Promise.resolve() } : {})
          };
          return writer;
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError') return null;
          throw error;
        }
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
  clipboardWrite: (hosts.secureContext && typeof hosts.clipboard?.writeText === 'function') || typeof hosts.legacyCopy === 'function',
  dialogs: typeof hosts.confirm === 'function',
  externalLinks: typeof hosts.openExternal === 'function',
  fileSave: typeof hosts.fileSave?.save === 'function',
  fileWriter: typeof hosts.fileWriter?.open === 'function',
  downloads: typeof hosts.download === 'function',
  notifications: hosts.notifications !== undefined
});

const createClipboardPort = (
  hosts: BrowserSystemHosts,
  capabilities: BrowserSystemCapabilities
): ClipboardPort => ({
  canRead: capabilities.clipboardRead,
  canWrite: capabilities.clipboardWrite,
  async readText(): Promise<string> {
    if (!capabilities.clipboardRead || !hosts.clipboard?.readText) throw unavailable();
    try {
      return await hosts.clipboard.readText();
    } catch {
      throw unavailable();
    }
  },
  async writeText(text: string): Promise<void> {
    if (!capabilities.clipboardWrite) throw unavailable();
    if (hosts.secureContext && hosts.clipboard?.writeText) {
      try {
        await hosts.clipboard.writeText(text);
        return;
      } catch {
        // Fall through to the user-gesture-compatible legacy path.
      }
    }
    if (hosts.legacyCopy) {
      try {
        if (hosts.legacyCopy(text) !== false) return;
      } catch {
        // Normalize the browser failure below.
      }
    }
    throw unavailable();
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

const createFileWriterPort = (
  hosts: BrowserSystemHosts,
  capabilities: BrowserSystemCapabilities
): FileWriterPort => ({
  async open(request): Promise<FileWriter | null> {
    if (!capabilities.fileWriter || !hosts.fileWriter) throw unavailable();
    try {
      return await hosts.fileWriter.open(request);
    } catch {
      throw unavailable();
    }
  }
});

const createDialogPort = (
  hosts: BrowserSystemHosts,
  capabilities: BrowserSystemCapabilities
): DialogPort => ({
  async confirm(message: string): Promise<boolean> {
    if (!capabilities.dialogs || !hosts.confirm) throw unavailable();
    try {
      return await hosts.confirm(message);
    } catch {
      throw unavailable();
    }
  }
});

const createExternalLinkPort = (
  hosts: BrowserSystemHosts,
  capabilities: BrowserSystemCapabilities
): ExternalLinkPort => ({
  async open(url: string): Promise<void> {
    if (!capabilities.externalLinks || !hosts.openExternal) throw unavailable();
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw unavailable();
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw unavailable();
    try {
      await hosts.openExternal(parsed.toString());
    } catch {
      throw unavailable();
    }
  }
});

const createDownloadPort = (
  hosts: BrowserSystemHosts,
  capabilities: BrowserSystemCapabilities
): DownloadPort => ({
  async download(request): Promise<void> {
    if (!capabilities.downloads || !hosts.download) throw unavailable();
    if (!request.name || request.name.length > 255 || request.name.includes('\u0000')) throw new AppError('PROTOCOL_INVALID_MESSAGE');
    try {
      await hosts.download(request);
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
    preferences: hosts.preferences,
    session: hosts.session,
    clipboard: createClipboardPort(hosts, capabilities),
    dialogs: createDialogPort(hosts, capabilities),
    externalLinks: createExternalLinkPort(hosts, capabilities),
    downloads: createDownloadPort(hosts, capabilities),
    fileSave: createFileSavePort(hosts, capabilities),
    fileWriter: createFileWriterPort(hosts, capabilities),
    notifications: createNotificationPort(hosts, capabilities)
  };
};
