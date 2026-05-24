import { useEffect, useState } from 'react';

import type { AppStatus } from '../shared/types';
import { AnswerHUD } from './views/AnswerHUD';
import { BootOverlay } from './views/BootOverlay';
import { ChatPopup } from './views/ChatPopup';
import { CommandPalette } from './views/CommandPalette';
import { MobileApp } from './views/mobile/MobileApp';
import { Setup } from './views/Setup';
import { Shell } from './views/Shell';
import { TrayMenu } from './views/TrayMenu';
import { VoiceOrb } from './views/VoiceOrb';

/** True when the renderer is loaded inside Electron — the preload
 *  bridge populates window.jarvis. On the mobile PWA the same
 *  bundle loads in mobile Safari with no preload, so we guard the
 *  Electron-only IPC paths. */
const IS_ELECTRON = typeof window.jarvis !== 'undefined';

function getRoute(): string {
  const hash = window.location.hash.replace(/^#/, '');
  // Strip query string so '/chat-popup?taskId=…' still matches '/chat-popup'.
  const path = hash.split('?')[0] ?? '';
  return path || '/observatory';
}

export function App() {
  const [route, setRoute] = useState(getRoute());
  const [status, setStatus] = useState<AppStatus | null>(null);
  /**
   * Show the boot overlay on every initial mount of the main window.
   * Cold start (quit + reopen) and renderer reload (⌘R in dev) both
   * count — the user explicitly wanted the animation on reload too.
   * Palette + HUD routes still skip it.
   */
  const [bootDone, setBootDone] = useState(false);

  useEffect(() => {
    const onHash = () => setRoute(getRoute());
    window.addEventListener('hashchange', onHash);
    // window.jarvis is only present inside Electron — on the
    // mobile PWA there's no preload, so we skip the status IPC.
    // MobileApp pulls its own status via the HTTP API.
    if (!IS_ELECTRON) {
      return () => window.removeEventListener('hashchange', onHash);
    }
    void window.jarvis.getStatus().then(setStatus);
    const off = window.jarvis.onAppStatus(setStatus);
    return () => {
      off();
      window.removeEventListener('hashchange', onHash);
    };
  }, []);

  // Add a body class for transparent frameless windows so the shell's
  // scanline overlay (which would render on top of them) is suppressed.
  useEffect(() => {
    const transparent =
      route === '/palette' ||
      route === '/answer-hud' ||
      route === '/tray-menu' ||
      route === '/voice-orb';
    if (transparent) document.body.classList.add('palette-body');
    else document.body.classList.remove('palette-body');
  }, [route]);

  // "System came online" pulse: add a transient class right when the
  // boot overlay finishes fading out, which scopes a one-shot CSS
  // animation on the Shell's nav border + the dashboard section
  // reveal. Class is auto-removed after the longest child animation
  // completes so subsequent renders stay passive.
  useEffect(() => {
    if (!bootDone) return;
    document.body.classList.add('jarvis-just-loaded');
    const t = setTimeout(
      () => document.body.classList.remove('jarvis-just-loaded'),
      2200,
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
  if (route === '/chat-popup') {
    if (!status || !isReady(status)) return null;
    return <ChatPopup />;
  }
  if (route === '/tray-menu') {
    return <TrayMenu />;
  }
  if (route === '/voice-orb') {
    return <VoiceOrb />;
  }
  if (route === '/mobile') {
    // The PWA target — same React bundle, totally different
    // surface (touch-first, runs in mobile Safari with no
    // Electron preload available).
    return <MobileApp />;
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
