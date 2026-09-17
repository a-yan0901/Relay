import { describe, expect, it, vi } from 'vitest';

import { DesktopIpcRouter } from '../../../apps/windows/ipc-contract.js';
import { createDesktopMainController, DESKTOP_IPC_CHANNEL, DESKTOP_RENDERER_POLICY, registerDesktopIpc } from '../../../apps/windows/main.js';
import { createWindowsDesktopApplication } from '../../../apps/windows/application.js';

describe('Windows desktop main shell', () => {
  it('registers one sender-bound IPC channel and enforces renderer policy', async () => {
    const handle = vi.fn();
    const ipcMain = { handle, removeHandler: vi.fn() };
    const window = { id: 42, loadFile: vi.fn(async () => undefined), on: vi.fn(), webContents: { send: vi.fn() } };
    const controller = await createDesktopMainController(ipcMain, { create: vi.fn(() => window) }, 'index.html', (router) => {
      router.register('vault.status', async () => ({ phase: 'locked' }));
    });
    expect(handle).toHaveBeenCalledWith(DESKTOP_IPC_CHANNEL, expect.any(Function));
    expect(window.loadFile).toHaveBeenCalledWith('index.html');
    expect(controller.router.handlerCount).toBe(1);
    expect((vi.mocked((ipcMain as typeof ipcMain).handle).mock.calls[0]?.[0])).toBe(DESKTOP_IPC_CHANNEL);
    expect(DESKTOP_RENDERER_POLICY).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false });
  });

  it('rejects a request from a different renderer sender before dispatch', async () => {
    const handler = vi.fn();
    registerDesktopIpc({ handle: handler }, new DesktopIpcRouter(), (senderId) => senderId === 42);
    const listener = handler.mock.calls[0]?.[1] as (event: { sender: { id: number } }, request: unknown) => Promise<unknown>;
    await expect(listener({ sender: { id: 7 } }, { version: 1, requestId: 'request-1', operation: 'vault.status', payload: {} })).resolves.toMatchObject({ ok: false, error: { code: 'CAPABILITY_UNAVAILABLE' } });
  });

  it('composes the local runtime with the renderer shell and forwards bounded events', async () => {
    const handle = vi.fn();
    const ipcMain = { handle, removeHandler: vi.fn() };
    const window = { id: 42, loadFile: vi.fn(async () => undefined), on: vi.fn(), webContents: { send: vi.fn() } };
    const router = new DesktopIpcRouter();
    router.register('vault.status', async () => ({ phase: 'locked' }));
    const subscribe = vi.fn((listener: (event: unknown) => void) => {
      listener({ version: 1, generation: 1, sequence: 1, kind: 'terminal.status', sessionId: 'session-1', payload: { state: 'connected' } });
      return vi.fn();
    });
    const close = vi.fn(async () => undefined);
    const application = await createWindowsDesktopApplication({
      ipcMain,
      windowFactory: { create: vi.fn(() => window) },
      rendererFile: 'index.html',
      runtime: { router, subscribe, close }
    });
    expect(window.webContents.send).toHaveBeenCalledWith('relay:event', expect.objectContaining({ kind: 'terminal.status' }));
    await application.close();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
