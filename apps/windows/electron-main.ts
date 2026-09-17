import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron';
import { open as openFile, rename as renameFile, unlink as unlinkFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { createWindowsDesktopApplication, type WindowsDesktopApplication } from './application.js';
import type { WindowsLocalFileWriter } from './local-runtime.js';
import { type DesktopWindowFactory, type DesktopWindowLike } from './main.js';

let application: WindowsDesktopApplication | null = null;
let activeWindow: BrowserWindow | null = null;
let quitting = false;

const windowFactory = (preloadPath: string): DesktopWindowFactory => ({
  create(policy): DesktopWindowLike {
    const window = new BrowserWindow({
      width: 1440,
      height: 900,
      minWidth: 960,
      minHeight: 640,
      backgroundColor: '#141728',
      show: false,
      webPreferences: {
        ...policy,
        preload: preloadPath
      }
    });
    activeWindow = window;
    window.once('ready-to-show', () => window.show());
    return {
      id: window.id,
      loadFile: (path) => window.loadFile(path),
      on: (event, listener) => { window.on(event, listener); },
      webContents: {
        send: (channel, value) => { window.webContents.send(channel, value); },
        setWindowOpenHandler: (handler) => window.webContents.setWindowOpenHandler((details) => handler({ url: details.url })),
        on: (event, listener) => {
          window.webContents.on(event, (nativeEvent, url) => listener({ preventDefault: () => nativeEvent.preventDefault() }, url));
        }
      }
    };
  }
});

const focusWindow = (): void => {
  if (!activeWindow || activeWindow.isDestroyed()) return;
  if (activeWindow.isMinimized()) activeWindow.restore();
  activeWindow.show();
  activeWindow.focus();
};

const createFileWriter = async (request: { name: string; mimeType: string }): Promise<WindowsLocalFileWriter | null> => {
  if (!activeWindow || activeWindow.isDestroyed()) return null;
  const result = await dialog.showSaveDialog(activeWindow, {
    title: '保存文件',
    defaultPath: join(app.getPath('downloads'), request.name),
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

const createApplication = async (): Promise<void> => {
  const rendererFile = join(app.getAppPath(), 'dist', 'web', 'index.html');
  const preloadPath = join(app.getAppPath(), 'dist', 'windows', 'electron-preload.cjs');
  application = await createWindowsDesktopApplication({
    dataDir: app.getPath('userData'),
    ipcMain,
    windowFactory: windowFactory(preloadPath),
    rendererFile,
    systemServices: {
      clipboard: {
        readText: () => clipboard.readText(),
        writeText: (text) => clipboard.writeText(text)
      },
      confirm: async (message) => {
        if (!activeWindow || activeWindow.isDestroyed()) return false;
        const result = await dialog.showMessageBox(activeWindow, {
          type: 'question',
          title: 'Relay',
          message,
          buttons: ['继续', '取消'],
          defaultId: 1,
          cancelId: 1,
          noLink: true
        });
        return result.response === 0;
      },
      openExternal: (url) => shell.openExternal(url),
      fileSave: { open: createFileWriter }
    }
  });
};

const start = async (): Promise<void> => {
  await app.whenReady();
  app.on('activate', focusWindow);
  await createApplication();
};

if (app.requestSingleInstanceLock()) {
  app.on('second-instance', focusWindow);
  app.on('before-quit', (event) => {
    if (!application || quitting) return;
    event.preventDefault();
    quitting = true;
    void application.close().finally(() => app.quit());
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  void start().catch((error: unknown) => {
    dialog.showErrorBox('Relay 启动失败', error instanceof Error ? error.message : '无法启动桌面应用');
    app.quit();
  });
} else {
  app.quit();
}
