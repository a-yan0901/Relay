import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { webAdapters } from './platform/web-adapters';
import { registerPwaServiceWorker } from './platform/pwa-registration';
import { createPlatformRuntime } from './platform/runtime-bootstrap';
import { bootstrapPreferences } from './theme';
import './styles.css';
import '@xterm/xterm/css/xterm.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element is missing');
}

const runtime = createPlatformRuntime();
bootstrapPreferences(runtime.platformServices?.preferences ?? null);
if (runtime === webAdapters) void registerPwaServiceWorker();

createRoot(root).render(
  <StrictMode>
    <App runtime={runtime} />
  </StrictMode>
);
