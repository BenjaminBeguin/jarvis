import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles/global.css';

// Register the PWA service worker only on the mobile route — the
// desktop Electron renderer doesn't need it and trying to
// register one inside Electron triggers protocol errors. Manual
// registration avoids the virtual:pwa-register helper module
// which has finicky TS resolution across pnpm versions; the
// auto-update behaviour comes from `updateSW` calls + reload on
// `controllerchange` if we need it later.
if (typeof window.jarvis === 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('[pwa] sw register failed', err);
    });
  });
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <StrictMode>
    <App />
  </StrictMode>,
);
