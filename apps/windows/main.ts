import { DesktopIpcRouter, type DesktopIpcResponse } from './ipc-contract.js';

export const DESKTOP_IPC_CHANNEL = 'relay:invoke';
export const DESKTOP_EVENT_CHANNEL = 'relay:event';
export const DESKTOP_RENDERER_POLICY = {
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  allowRunningInsecureContent: false,
  webviewTag: false
} as const;

export interface DesktopIpcEventLike {
  sender: { id: number };
}

export interface DesktopIpcMainLike {
  handle(channel: string, listener: (event: DesktopIpcEventLike, request: unknown) => Promise<DesktopIpcResponse>): void;
  removeHandler?(channel: string): void;
}

export interface DesktopWindowLike {
  id: number;
  loadFile(path: string): Promise<void>;
  on(event: 'closed', listener: () => void): void;
  webContents: {
    send(channel: string, value: unknown): void;
    setWindowOpenHandler?(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void;
    on?(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): void;
  };
}

export interface DesktopWindowFactory {
  create(options: typeof DESKTOP_RENDERER_POLICY): DesktopWindowLike;
}

export interface DesktopMainController {
  router: DesktopIpcRouter;
  window: DesktopWindowLike;
  close(): void;
}

export const registerDesktopIpc = (
  ipcMain: DesktopIpcMainLike,
  router: DesktopIpcRouter,
  isAllowedSender: (senderId: number) => boolean
): void => {
  ipcMain.handle(DESKTOP_IPC_CHANNEL, async (event, request) => {
    if (!isAllowedSender(event.sender.id)) {
      return { version: 1, requestId: 'invalid', ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: '当前窗口不允许调用此操作' } };
    }
    return router.dispatch(request);
  });
};

export const configureDesktopNavigationGuards = (window: DesktopWindowLike): void => {
  window.webContents.setWindowOpenHandler?.(() => ({ action: 'deny' }));
  window.webContents.on?.('will-navigate', (event, url) => {
    if (!url.startsWith('file:')) event.preventDefault();
  });
};

export const createDesktopMainController = async (
  ipcMain: DesktopIpcMainLike,
  windowFactory: DesktopWindowFactory,
  rendererFile: string,
  registerHandlers: (router: DesktopIpcRouter) => void,
  existingRouter?: DesktopIpcRouter
): Promise<DesktopMainController> => {
  const router = existingRouter ?? new DesktopIpcRouter();
  registerHandlers(router);
  const window = windowFactory.create(DESKTOP_RENDERER_POLICY);
  configureDesktopNavigationGuards(window);
  registerDesktopIpc(ipcMain, router, (senderId) => senderId === window.id);
  let closed = false;
  window.on('closed', () => { closed = true; });
  await window.loadFile(rendererFile);
  return {
    router,
    window,
    close: () => {
      if (closed) return;
      closed = true;
      ipcMain.removeHandler?.(DESKTOP_IPC_CHANNEL);
    }
  };
};
