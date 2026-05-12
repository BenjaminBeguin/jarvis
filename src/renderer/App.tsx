import { useEffect, useState } from 'react';

import type { AppStatus } from '../shared/types';
import { CommandPalette } from './views/CommandPalette';
import { Setup } from './views/Setup';
import { Shell } from './views/Shell';

function getRoute(): string {
  const hash = window.location.hash.replace(/^#/, '');
  return hash || '/observatory';
}

export function App() {
  const [route, setRoute] = useState(getRoute());
  const [status, setStatus] = useState<AppStatus | null>(null);

  useEffect(() => {
    void window.jarvis.getStatus().then(setStatus);
    const off = window.jarvis.onAppStatus(setStatus);
    const onHash = () => setRoute(getRoute());
    window.addEventListener('hashchange', onHash);
    return () => {
      off();
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  // Add a body class for the palette window so the scanline overlay (which
  // would render on top of the transparent frameless window) is suppressed.
  useEffect(() => {
    if (route === '/palette') document.body.classList.add('palette-body');
    else document.body.classList.remove('palette-body');
  }, [route]);

  if (!status) return null;

  const ready = isReady(status);

  if (route === '/palette') {
    if (!ready) return null;
    return <CommandPalette />;
  }

  if (!ready) return <Setup status={status} />;
  return <Shell status={status} />;
}

function isReady(status: AppStatus): boolean {
  if (status.authMode === 'subscription') return !!status.claudeBinaryPath;
  if (status.authMode === 'api-key') return status.hasApiKey;
  return false;
}
