import { useEffect, useState } from 'react';

import { Logo } from './Logo';

/**
 * Cold-boot overlay. Mounts before the Shell, plays a short animated
 * sequence, then fades out once both:
 *   1. main has sent the first AppStatus payload (`ready` prop), AND
 *   2. the minimum on-screen duration has elapsed.
 *
 * "First launch" = every cold start of the app (BrowserWindow loaded
 * fresh, including after a full system close + reopen). Reload of the
 * renderer (⌘R during dev) keeps the same browser session and skips
 * the overlay — the App component renders the Shell directly. The
 * gate is `sessionStorage`, which resets on every BrowserWindow load
 * but persists across page reloads in the same window.
 *
 * Two cadences:
 *   - Cold start (no sessionStorage flag) → full sequence with the
 *     terminal-style "INITIALIZING" lines. ~2200ms minimum.
 *   - In-session reload → renderer never mounts this overlay (App's
 *     gate skips it); falls straight through to the Shell.
 *
 * Force-replay the full intro in dev: `sessionStorage.clear()` then
 * ⌘R in DevTools.
 */

const SEEN_KEY = 'jarvis.bootSeen';
const COLD_START_MIN_MS = 2200;
const FADE_OUT_MS = 320;

/** Public helper so App.tsx can decide whether to mount the overlay
 *  at all. Cold start = no flag in sessionStorage. */
export function shouldShowBootOverlay(): boolean {
  try {
    return !window.sessionStorage.getItem(SEEN_KEY);
  } catch {
    return true;
  }
}

type Phase = 'playing' | 'fading' | 'done';

const BOOT_LINES = [
  'cold boot · v0',
  'loading skills',
  'wiring mcp servers',
  'rehydrating routines',
  'subscribing to inbox sources',
  'arming meeting watcher',
  'ready',
];

export function BootOverlay({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [phase, setPhase] = useState<Phase>('playing');
  const [linesShown, setLinesShown] = useState(0);
  const [minDurationElapsed, setMinDurationElapsed] = useState(false);

  useEffect(() => {
    // Mark seen for this BrowserWindow session so an in-session reload
    // (⌘R) skips the overlay. Cleared automatically when the window
    // closes; next cold start replays the full sequence.
    try {
      window.sessionStorage.setItem(SEEN_KEY, '1');
    } catch {
      // ignore (private-mode storage failures)
    }
  }, []);

  // Incrementally reveal terminal lines.
  useEffect(() => {
    if (phase !== 'playing') return;
    if (linesShown >= BOOT_LINES.length) return;
    const t = setTimeout(() => setLinesShown((n) => n + 1), 240);
    return () => clearTimeout(t);
  }, [phase, linesShown]);

  // Minimum on-screen duration so the animation doesn't flicker on a
  // fast boot. After elapses, we check `ready` to start the fade.
  useEffect(() => {
    const t = setTimeout(() => setMinDurationElapsed(true), COLD_START_MIN_MS);
    return () => clearTimeout(t);
  }, []);

  // Start the fade as soon as both the min duration AND the status
  // arrival are satisfied. Status can come either way around — main
  // might be slow on a cold start, or fast and we're still animating.
  useEffect(() => {
    if (phase !== 'playing') return;
    if (!ready || !minDurationElapsed) return;
    setPhase('fading');
    const t = setTimeout(() => {
      setPhase('done');
      onDone();
    }, FADE_OUT_MS);
    return () => clearTimeout(t);
  }, [phase, ready, minDurationElapsed, onDone]);

  if (phase === 'done') return null;

  return (
    <div
      className={`boot-overlay${phase === 'fading' ? ' boot-overlay--fading' : ''}`}
      aria-hidden
    >
      <div className="boot-overlay__scanlines" />
      <div className="boot-overlay__sweep" />
      <div className="boot-overlay__center">
        <div className="boot-overlay__logo">
          <Logo />
        </div>
        <div className="boot-overlay__brand">JARVIS</div>
        <div className="boot-overlay__sub">personal AI operating layer</div>
        <ul className="boot-overlay__lines">
          {BOOT_LINES.slice(0, linesShown).map((line, i) => {
            const isLast = i === BOOT_LINES.length - 1;
            return (
              <li
                key={line}
                className={`boot-overlay__line${isLast ? ' boot-overlay__line--ready' : ''}`}
              >
                <span className="boot-overlay__line-tick">›</span>
                <span className="boot-overlay__line-text">{line}</span>
                <span className="boot-overlay__line-status">
                  {isLast ? '✓' : 'ok'}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
