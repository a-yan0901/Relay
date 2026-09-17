import type { ClipboardPort, PlatformServices } from '../../shared/core/ports.js';
import { AppError } from '../../shared/errors.js';
import type { NativeOperationPort } from '../../shared/native/core-runtime.js';

const MAX_CLIPBOARD_TEXT = 64 * 1024;

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
  return { clipboard };
};
