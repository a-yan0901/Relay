import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(root, 'src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    setupFiles: ['./tests/setup.ts'],
    // The development host has limited RAM and no swap. Keep native/SSH
    // tests deterministic without multiplying Node/Vite workers.
    fileParallelism: false,
    maxWorkers: 1,
    // A full isolated run starts every file sequentially; server integration
    // setup can exceed Vitest's 5s default on this low-memory host even when
    // the test itself completes in a few hundred milliseconds.
    testTimeout: 15_000,
    hookTimeout: 15_000
  }
});
