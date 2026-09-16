import { describe, expect, it, vi } from 'vitest';

import {
  isStandaloneDisplayMode,
  registerPwaServiceWorker,
  type PwaRegistrationEnvironment
} from '../../../src/web/platform/pwa-registration.js';

const environment = (overrides: Partial<PwaRegistrationEnvironment> = {}): PwaRegistrationEnvironment => ({
  serviceWorker: {
    register: vi.fn(async () => undefined)
  },
  matchMedia: () => ({ matches: false }),
  iosStandalone: false,
  ...overrides
});

describe('PWA registration', () => {
  it('registers the root-scoped service worker when supported', async () => {
    const env = environment();

    await expect(registerPwaServiceWorker(env)).resolves.toEqual({ supported: true, registered: true });
    expect(env.serviceWorker?.register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
  });

  it('does not block startup when service workers are unavailable or registration fails', async () => {
    await expect(registerPwaServiceWorker(environment({ serviceWorker: undefined }))).resolves.toEqual({ supported: false, registered: false });
    await expect(registerPwaServiceWorker(environment({
      serviceWorker: { register: vi.fn(async () => { throw new Error('blocked'); }) }
    }))).resolves.toEqual({ supported: true, registered: false });
  });

  it('detects standalone display mode in browser and iOS environments', () => {
    expect(isStandaloneDisplayMode(environment({ matchMedia: () => ({ matches: true }) }))).toBe(true);
    expect(isStandaloneDisplayMode(environment({ iosStandalone: true }))).toBe(true);
    expect(isStandaloneDisplayMode(environment())).toBe(false);
  });
});
