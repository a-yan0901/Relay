import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The Electron renderer is loaded from a file:// URL. Absolute asset URLs
  // resolve to the drive root there instead of the packaged renderer folder.
  base: './',
  resolve: {
    alias: {
      '@shared': '/src/shared'
    }
  },
  server: {
    port: Number(process.env.VITE_PORT ?? 5173),
    proxy: {
      '/api': `http://127.0.0.1:${process.env.WEBSSH_API_PORT ?? 3000}`,
      '/ws': {
        target: `ws://127.0.0.1:${process.env.WEBSSH_API_PORT ?? 3000}`,
        ws: true
      }
    }
  }
});
