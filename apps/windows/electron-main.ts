import { app, BrowserWindow, clipboard, dialog, ipcMain, Notification as ElectronNotification, shell } from 'electron';
import { join } from 'node:path';

import { createWindowsDesktopApplication, type WindowsDesktopApplication } from './application.js';
import { type DesktopWindowFactory, type DesktopWindowLike } from './main.js';
import { createWindowsFileSource, createWindowsFileWriter, type NativeFileDialog } from './native-file-services.js';

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

const notificationPermission = (): 'granted' | 'denied' => ElectronNotification.isSupported() ? 'granted' : 'denied';

const nativeFileDialog: NativeFileDialog = {
  showOpenDialog: (window, options) => dialog.showOpenDialog(window, options),
  showSaveDialog: (window, options) => dialog.showSaveDialog(window, options)
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
      fileOpen: { open: () => createWindowsFileSource(activeWindow, nativeFileDialog) },
      notifications: {
        permission: notificationPermission,
        requestPermission: notificationPermission,
        notify: (request) => {
          if (notificationPermission() !== 'granted') throw new Error('desktop notifications are unavailable');
          new ElectronNotification({ title: request.title, body: request.body }).show();
        }
      },
      fileSave: { open: (request) => createWindowsFileWriter(activeWindow, app.getPath('downloads'), request, nativeFileDialog) }
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
