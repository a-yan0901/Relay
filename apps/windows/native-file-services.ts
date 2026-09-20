import type { BrowserWindow, OpenDialogOptions, SaveDialogOptions } from 'electron';
import { createReadStream } from 'node:fs';
import { open as openFile, rename as renameFile, stat, unlink as unlinkFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

import type { WindowsLocalFileSource, WindowsLocalFileWriter } from './local-runtime.js';

export interface NativeFileDialog {
  showOpenDialog(window: BrowserWindow, options: OpenDialogOptions): Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog(window: BrowserWindow, options: SaveDialogOptions): Promise<{ canceled: boolean; filePath?: string }>;
}

const hasUsableWindow = (window: BrowserWindow | null): window is BrowserWindow => Boolean(window && !window.isDestroyed());

export const createWindowsFileSource = async (activeWindow: BrowserWindow | null, fileDialog: NativeFileDialog): Promise<WindowsLocalFileSource | null> => {
  if (!hasUsableWindow(activeWindow)) return null;
  const result = await fileDialog.showOpenDialog(activeWindow, {
    title: '选择上传文件',
    buttonLabel: '选择',
    properties: ['openFile']
  });
  if (result.canceled || result.filePaths.length === 0) return null;

  const filePath = result.filePaths[0];
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) return null;
  let stream: ReturnType<typeof createReadStream> | null = null;
  let closed = false;
  return {
    name: basename(filePath),
    size: fileInfo.size,
    stream(): AsyncIterable<Uint8Array> {
      if (closed) throw new Error('file source is closed');
      stream = createReadStream(filePath, { highWaterMark: 32 * 1024 });
      return stream;
    },
    async close(): Promise<void> {
      closed = true;
      stream?.destroy();
      stream = null;
    }
  };
};

export const createWindowsFileWriter = async (
  activeWindow: BrowserWindow | null,
  downloadsPath: string,
  request: { name: string; mimeType: string },
  fileDialog: NativeFileDialog
): Promise<WindowsLocalFileWriter | null> => {
  if (!hasUsableWindow(activeWindow)) return null;
  const result = await fileDialog.showSaveDialog(activeWindow, {
    title: '保存文件',
    defaultPath: join(downloadsPath, request.name),
    buttonLabel: '保存',
    properties: ['createDirectory', 'showOverwriteConfirmation'],
    filters: [{ name: request.mimeType, extensions: request.name.includes('.') ? [request.name.split('.').pop() ?? 'bin'] : ['bin'] }]
  });
  if (result.canceled || !result.filePath) return null;

  const targetPath = result.filePath;
  const partialPath = `${targetPath}.relay-partial-${randomUUID()}`;
  const handle = await openFile(partialPath, 'wx');
  let offset = 0;
  let closed = false;

  const cleanupPartial = async (): Promise<void> => {
    await unlinkFile(partialPath).catch(() => undefined);
  };

  return {
    async write(data): Promise<void> {
      if (closed) throw new Error('file writer is closed');
      let written = 0;
      while (written < data.byteLength) {
        const result = await handle.write(data, written, data.byteLength - written, offset + written);
        if (result.bytesWritten <= 0) throw new Error('file writer made no progress');
        written += result.bytesWritten;
      }
      offset += written;
    },
    async seek(position): Promise<void> {
      if (closed || !Number.isSafeInteger(position) || position < 0) throw new Error('invalid file position');
      offset = position;
    },
    async close(): Promise<void> {
      if (closed) return;
      try {
        await handle.close();
        await unlinkFile(targetPath).catch((error: unknown) => {
          if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
        });
        await renameFile(partialPath, targetPath);
      } catch (error) {
        await cleanupPartial();
        throw error;
      } finally {
        closed = true;
      }
    },
    async cancel(): Promise<void> {
      if (closed) return;
      closed = true;
      await handle.close().catch(() => undefined);
      await cleanupPartial();
    }
  };
};
