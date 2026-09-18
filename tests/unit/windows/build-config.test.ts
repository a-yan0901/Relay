import { describe, expect, it } from 'vitest';

import webConfig from '../../../vite.config.js';
import preloadConfig from '../../../apps/windows/tsup-preload.config.js';
import packageJson from '../../../package.json';

describe('Windows build configuration', () => {
  it('emits relative renderer assets for Electron file URLs', () => {
    expect(webConfig.base).toBe('./');
  });

  it('bundles schema validation into the sandboxed preload', () => {
    expect(preloadConfig.noExternal).toContain('zod');
  });

  it('launches the development app from the package root', () => {
    expect(packageJson.scripts['dev:windows']).toBe('npm run build:windows && electron .');
  });
});
