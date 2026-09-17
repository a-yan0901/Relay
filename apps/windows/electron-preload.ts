import { contextBridge, ipcRenderer } from 'electron';

import { createElectronPreloadApi, exposeDesktopPreloadApi } from './preload.js';

const api = createElectronPreloadApi({
  invoke: (channel, request) => ipcRenderer.invoke(channel, request),
  on: (channel, listener) => ipcRenderer.on(channel, listener),
  removeListener: (channel, listener) => ipcRenderer.removeListener(channel, listener)
});

exposeDesktopPreloadApi(contextBridge, api);
