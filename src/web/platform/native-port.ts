import type { NativeOperationPort } from '../../shared/native/core-runtime.js';
import { createAndroidNativeBridge, type AndroidNativePlugin } from './android-bridge.js';

export interface DesktopNativeBridge {
  invoke(operation: string, payload: unknown): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
}

interface NativeWindowGlobals extends Window {
  relayDesktop?: DesktopNativeBridge;
  relayAndroid?: AndroidNativePlugin;
  Capacitor?: {
    Plugins?: {
      RelayNative?: AndroidNativePlugin;
    };
  };
}

export interface NativePlatformPort {
  platform: 'desktop' | 'android';
  port: NativeOperationPort;
}

let cachedSource: object | null = null;
let cachedPort: NativePlatformPort | null = null;

const asNativeWindow = (): NativeWindowGlobals => globalThis as unknown as NativeWindowGlobals;

/**
 * Returns one bridge per renderer-side native host. Keeping the bridge shared
 * prevents the terminal hook and the CoreRuntime from registering duplicate
 * Android event listeners and keeps native event memory bounded.
 */
export const getNativePlatformPort = (): NativePlatformPort | null => {
  const nativeWindow = asNativeWindow();
  if (nativeWindow.relayDesktop) {
    if (cachedSource === nativeWindow.relayDesktop && cachedPort) return cachedPort;
    const desktop = nativeWindow.relayDesktop;
    cachedSource = desktop;
    cachedPort = {
      platform: 'desktop',
      port: {
        invoke: <T,>(operation: string, payload: unknown) => desktop.invoke(operation, payload) as Promise<T>,
        subscribe: (listener) => desktop.subscribe(listener as (event: unknown) => void)
      }
    };
    return cachedPort;
  }

  const androidPlugin = nativeWindow.relayAndroid ?? nativeWindow.Capacitor?.Plugins?.RelayNative;
  if (androidPlugin) {
    if (cachedSource === androidPlugin && cachedPort) return cachedPort;
    cachedSource = androidPlugin;
    cachedPort = { platform: 'android', port: createAndroidNativeBridge(androidPlugin) };
    return cachedPort;
  }

  cachedSource = null;
  cachedPort = null;
  return null;
};
