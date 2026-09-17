import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['apps/windows/electron-main.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'dist/windows',
  sourcemap: true,
  clean: true,
  external: ['electron', 'argon2', 'better-sqlite3', 'ssh2']
});
