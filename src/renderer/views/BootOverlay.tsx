import { useEffect, useState } from 'react';

import { Logo } from './Logo';

/**
 * Cold-boot overlay. Mounts before the Shell on every initial render
 * of the main window (cold start AND renderer reload), plays a short
 * animated sequence, then fades out once both:
 *   1. main has sent the first AppStatus payload (`ready` prop), AND
 *   2. the minimum on-screen duration has elapsed.
 *
 * Palette + HUD routes don't mount this; App.tsx skips it for them.
 */

const COLD_START_MIN_MS = 2200;
const FADE_OUT_MS = 320;

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
