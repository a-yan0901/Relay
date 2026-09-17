import type { DesktopIpcMainLike, DesktopMainController, DesktopWindowFactory } from './main.js';
import { createDesktopMainController, DESKTOP_EVENT_CHANNEL } from './main.js';
import type { DesktopIpcRouter } from './ipc-contract.js';
import type { NativeEventFrame } from '../../src/shared/native/bridge.js';
import { createWindowsLocalRuntime, type WindowsLocalRuntimeOptions } from './local-runtime.js';

export interface WindowsLocalRuntimeLike {
  router: DesktopIpcRouter;
  subscribe(listener: (event: NativeEventFrame) => void): () => void;
  close(): Promise<void>;
}

export interface WindowsDesktopApplicationOptions extends Omit<WindowsLocalRuntimeOptions, 'dataDir'> {
  dataDir: string;
  ipcMain: DesktopIpcMainLike;
  windowFactory: DesktopWindowFactory;
  rendererFile: string;
  runtime?: WindowsLocalRuntimeLike;
}

export interface WindowsDesktopApplication {
  controller: DesktopMainController;
  runtime: WindowsLocalRuntimeLike;
  close(): Promise<void>;
}

export const createWindowsDesktopApplication = async (options: WindowsDesktopApplicationOptions): Promise<WindowsDesktopApplication> => {
  const runtime = options.runtime ?? createWindowsLocalRuntime(options);
  let closed = false;
  let stopEvents: (() => void) | undefined;
  let controller: DesktopMainController;
  try {
    controller = await createDesktopMainController(
      options.ipcMain,
      options.windowFactory,
      options.rendererFile,
      () => undefined,
      runtime.router
    );
    stopEvents = runtime.subscribe((event) => {
      if (closed) return;
      try {
        controller.window.webContents.send(DESKTOP_EVENT_CHANNEL, event);
      } catch {
        // A renderer may disappear between event delivery and window close.
      }
    });
  } catch (error) {
    await runtime.close();
    throw error;
  }

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    stopEvents?.();
    stopEvents = undefined;
    controller.close();
    await runtime.close();
  };
  controller.window.on('closed', () => { void close(); });
  return { controller, runtime, close };
};
