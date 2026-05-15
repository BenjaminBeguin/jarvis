import { useEffect, useState } from 'react';

import type { AppStatus } from '../shared/types';
import { AnswerHUD } from './views/AnswerHUD';
import { BootOverlay } from './views/BootOverlay';
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
  /**
   * Show the boot overlay on cold start of the main window only.
   * Palette + HUD routes load instantly into transparent frames; an
   * overlay there would just flash awkwardly. The Shell's first paint
   * triggers the fade-out once status is in hand.
   */
  const [bootDone, setBootDone] = useState(false);

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

  // Add a body class for transparent frameless windows so the shell's
  // scanline overlay (which would render on top of them) is suppressed.
  useEffect(() => {
    const transparent = route === '/palette' || route === '/answer-hud';
    if (transparent) document.body.classList.add('palette-body');
    else document.body.classList.remove('palette-body');
  }, [route]);

  // "System came online" pulse: add a transient class right when the
  // boot overlay finishes fading out, which scopes a one-shot CSS
  // animation on the Shell's nav border. ~1.4s, then we drop the
  // class so it stays passive after.
  useEffect(() => {
    if (!bootDone) return;
    document.body.classList.add('jarvis-just-loaded');
    const t = setTimeout(
      () => document.body.classList.remove('jarvis-just-loaded'),
      1600,
    );
    return () => clearTimeout(t);
  }, [bootDone]);

  // Transparent windows (palette / answer HUD) skip the boot overlay
  // entirely and just wait for status.
  if (route === '/palette') {
    if (!status || !isReady(status)) return null;
    return <CommandPalette />;
  }
  if (route === '/answer-hud') {
    if (!status || !isReady(status)) return null;
    return <AnswerHUD />;
  }

  // Main window: render the Shell behind the overlay so the underlying
  // UI is already painted by the time the fade-out ends — no flash of
  // empty content.
  const ready = status ? isReady(status) : false;
  const baseView = !status
    ? null
    : ready
      ? <Shell status={status} />
      : <Setup status={status} />;

  return (
    <>
      {baseView}
      {!bootDone && (
        <BootOverlay ready={!!status} onDone={() => setBootDone(true)} />
      )}
    </>
  );
}

function isReady(status: AppStatus): boolean {
  if (status.authMode === 'subscription') {
    return !!status.claudeBinaryPath && status.hasSubscriptionToken;
  }
  if (status.authMode === 'api-key') return status.hasApiKey;
  return false;
}
