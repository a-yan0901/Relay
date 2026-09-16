import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import { webAdapters } from './platform/web-adapters';
import './styles.css';
import '@xterm/xterm/css/xterm.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element is missing');
}

createRoot(root).render(
  <StrictMode>
    <App runtime={webAdapters} />
  </StrictMode>
);
