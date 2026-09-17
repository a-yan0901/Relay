import type { CoreRuntime } from '../../shared/core/runtime.js';
import { createNativeCoreRuntime } from '../../shared/native/core-runtime.js';
import { getNativePlatformPort } from './native-port.js';
import { createNativePlatformServices } from './native-platform-services.js';
import { webAdapters } from './web-adapters.js';

export const createPlatformRuntime = (): CoreRuntime => {
  const native = getNativePlatformPort();
  if (native) return createNativeCoreRuntime({ platform: native.platform, port: native.port, platformServices: createNativePlatformServices(native.port) });
  return webAdapters;
};
