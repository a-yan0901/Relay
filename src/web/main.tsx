import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { webAdapters } from './platform/web-adapters';
import { registerPwaServiceWorker } from './platform/pwa-registration';
import { bootstrapPreferences } from './theme';
import './styles.css';
import '@xterm/xterm/css/xterm.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element is missing');
}

bootstrapPreferences();
void registerPwaServiceWorker();

createRoot(root).render(
  <StrictMode>
    <App runtime={webAdapters} />
  </StrictMode>
);
