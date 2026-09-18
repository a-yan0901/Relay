import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['apps/windows/electron-preload.ts'],
  format: ['cjs'],
  target: 'node22',
  outDir: 'dist/windows',
  sourcemap: true,
  clean: false,
  external: ['electron'],
  noExternal: ['zod'],
  outExtension: () => ({ js: '.cjs' })
});
