import type { ClipboardPort, DialogPort, ExternalLinkPort, FileSavePort, FileWriter, FileWriterPort, PlatformServices, StoragePort } from '../../shared/core/ports.js';
import { AppError } from '../../shared/errors.js';
import { NATIVE_TRANSFER_CHUNK_BYTES, type NativeOperationPort } from '../../shared/native/core-runtime.js';

const MAX_CLIPBOARD_TEXT = 64 * 1024;
const MAX_DIALOG_TEXT = 4 * 1024;

const SAFE_WRITER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

const webViewStorage = (name: 'localStorage' | 'sessionStorage'): StoragePort | undefined => {
  try {
    const storage = globalThis[name];
    if (!storage) return undefined;
    return {
      getItem: (key) => storage.getItem(key),
      setItem: (key, value) => storage.setItem(key, value),
      removeItem: (key) => storage.removeItem(key)
    };
  } catch {
    return undefined;
  }
};

const toBase64Url = (value: Uint8Array): string => {
  if (typeof globalThis.btoa !== 'function') throw new AppError('CAPABILITY_UNAVAILABLE');
  let binary = '';
  for (const byte of value) binary += String.fromCodePoint(byte);
  return globalThis.btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

const boundedClipboardText = (value: string): string => {
  if (value.length > MAX_CLIPBOARD_TEXT) throw new AppError('FILE_TOO_LARGE', '剪贴板内容超出限制');
  return value;
};

export const createNativePlatformServices = (port: NativeOperationPort): PlatformServices => {
  const clipboard: ClipboardPort = {
    canRead: true,
    canWrite: true,
    async readText(): Promise<string> {
      const value = await port.invoke<unknown>('system.clipboard.readText', {});
      if (typeof value !== 'string') throw new AppError('PROTOCOL_INVALID_MESSAGE');
      return boundedClipboardText(value);
    },
    async writeText(text: string): Promise<void> {
      await port.invoke('system.clipboard.writeText', { text: boundedClipboardText(text) });
    }
  };
  const dialogs: DialogPort = {
    async confirm(message: string): Promise<boolean> {
      if (message.length > MAX_DIALOG_TEXT) throw new AppError('PROTOCOL_INVALID_MESSAGE');
      const value = await port.invoke<unknown>('system.confirm', { message });
      if (typeof value !== 'object' || value === null || Array.isArray(value) || typeof (value as { confirmed?: unknown }).confirmed !== 'boolean') throw new AppError('PROTOCOL_INVALID_MESSAGE');
      return (value as { confirmed: boolean }).confirmed;
    }
  };
  const externalLinks: ExternalLinkPort = {
    async open(url: string): Promise<void> {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw new AppError('PROTOCOL_INVALID_MESSAGE');
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new AppError('CAPABILITY_UNAVAILABLE');
      await port.invoke('system.openExternal', { url: parsed.toString() });
    }
  };
  const fileWriter: FileWriterPort = {
    async open(request): Promise<FileWriter | null> {
      const result = await port.invoke<unknown>('system.fileSave.open', request);
      if (result === null) return null;
      if (typeof result !== 'object' || result === null || Array.isArray(result) || typeof (result as { writerId?: unknown }).writerId !== 'string' || !SAFE_WRITER_ID.test((result as { writerId: string }).writerId)) {
        throw new AppError('PROTOCOL_INVALID_MESSAGE');
      }
      const writerId = (result as { writerId: string }).writerId;
      let closed = false;
      const writer: FileWriter = {
        async write(data: Uint8Array): Promise<void> {
          if (closed) throw new AppError('CAPABILITY_UNAVAILABLE');
          if (!(data instanceof Uint8Array) || data.byteLength > NATIVE_TRANSFER_CHUNK_BYTES) throw new AppError('FILE_TOO_LARGE');
          await port.invoke('system.fileSave.write', { writerId, data: toBase64Url(data) });
        },
        async seek(position: number): Promise<void> {
          if (closed || !Number.isSafeInteger(position) || position < 0) throw new AppError('PROTOCOL_INVALID_MESSAGE');
          await port.invoke('system.fileSave.seek', { writerId, position });
        },
        async close(): Promise<void> {
          if (closed) return;
          await port.invoke('system.fileSave.close', { writerId });
          closed = true;
        },
        async cancel(): Promise<void> {
          if (closed) return;
          try {
            await port.invoke('system.fileSave.cancel', { writerId }).catch(() => undefined);
          } finally {
            closed = true;
          }
        }
      };
      return writer;
    }
  };
  const fileSave: FileSavePort = {
    async save(request): Promise<void> {
      const writer = await fileWriter.open(request);
      if (!writer) throw new AppError('CAPABILITY_UNAVAILABLE');
      try {
        for (let offset = 0; offset < request.content.byteLength; offset += NATIVE_TRANSFER_CHUNK_BYTES) {
          await writer.write(request.content.subarray(offset, offset + NATIVE_TRANSFER_CHUNK_BYTES));
        }
        await writer.close();
      } catch (error) {
        await writer.cancel?.();
        throw error;
      }
    }
  };
  return { preferences: webViewStorage('localStorage'), session: webViewStorage('sessionStorage'), clipboard, dialogs, externalLinks, fileSave, fileWriter };
};
