import type { CoreRuntime } from '../../shared/core/runtime.js';
import { ANDROID_LOCAL_CAPABILITIES, createNativeCoreRuntime } from '../../shared/native/core-runtime.js';
import { getNativePlatformPort } from './native-port.js';
import { createNativePlatformServices } from './native-platform-services.js';
import { webAdapters } from './web-adapters.js';

export const createPlatformRuntime = (): CoreRuntime => {
  const native = getNativePlatformPort();
  if (native) return createNativeCoreRuntime({
    platform: native.platform,
    port: native.port,
    capabilities: native.platform === 'android' ? ANDROID_LOCAL_CAPABILITIES : undefined,
    platformServices: createNativePlatformServices(native.port, { notifications: native.platform === 'desktop' })
  });
  return webAdapters;
};
