export interface PwaServiceWorkerContainer {
  register(scriptURL: string, options?: { scope?: string }): Promise<unknown>;
}

export interface PwaMediaQueryResult {
  matches: boolean;
}

export interface PwaRegistrationEnvironment {
  serviceWorker?: PwaServiceWorkerContainer;
  matchMedia?: (query: string) => PwaMediaQueryResult;
  iosStandalone?: boolean;
}

export interface PwaRegistrationResult {
  supported: boolean;
  registered: boolean;
}

const defaultEnvironment = (): PwaRegistrationEnvironment => {
  const browserNavigator = typeof globalThis.navigator === 'undefined' ? undefined : globalThis.navigator;
  return {
    serviceWorker: browserNavigator?.serviceWorker,
    matchMedia: typeof globalThis.matchMedia === 'function' ? globalThis.matchMedia.bind(globalThis) : undefined,
    iosStandalone: Boolean((browserNavigator as (Navigator & { standalone?: boolean }) | undefined)?.standalone)
  };
};

export const registerPwaServiceWorker = async (
  environment: PwaRegistrationEnvironment = defaultEnvironment()
): Promise<PwaRegistrationResult> => {
  if (!environment.serviceWorker) return { supported: false, registered: false };
  try {
    await environment.serviceWorker.register('/sw.js', { scope: '/' });
    return { supported: true, registered: true };
  } catch {
    return { supported: true, registered: false };
  }
};

export const isStandaloneDisplayMode = (
  environment: PwaRegistrationEnvironment = defaultEnvironment()
): boolean => (
  environment.matchMedia?.('(display-mode: standalone)').matches === true || environment.iosStandalone === true
);
