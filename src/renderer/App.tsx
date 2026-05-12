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

  if (!status) return null;

  if (route === '/palette') {
    if (!status.hasApiKey) {
      // The palette window can't run tasks without an API key — bail out.
      return null;
    }
    return <CommandPalette />;
  }

  if (!status.hasApiKey) return <Setup />;
  return <Shell />;
}
