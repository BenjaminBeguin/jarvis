import { useEffect, useState } from 'react';

import { Logo } from './Logo';

/**
 * Cold-boot overlay. Mounts before the Shell, plays a short animated
 * sequence, then fades out once both:
 *   1. main has sent the first AppStatus payload (`ready` prop), AND
 *   2. the minimum on-screen duration has elapsed.
 *
 * Two cadences:
 *   - First launch ever (no localStorage flag) → full sequence with
 *     "INITIALIZING" terminal line by line. ~2200ms minimum.
 *   - Subsequent launches → quick logo flash + scanline sweep. ~700ms.
 *
 * The localStorage gate also lets the user re-trigger the full
 * animation by clearing the flag (`localStorage.removeItem(KEY)` in
 * the renderer devtools).
 *
 * Both flows end with a "READY" pulse that bleeds into the Shell.
 */

const SEEN_KEY = 'jarvis.bootSeen';
const FIRST_LAUNCH_MIN_MS = 2200;
const QUICK_LAUNCH_MIN_MS = 700;
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
  const [firstLaunch] = useState<boolean>(() => {
    try {
      return !window.localStorage.getItem(SEEN_KEY);
    } catch {
      return true;
    }
  });
  const [linesShown, setLinesShown] = useState(0);
  const [minDurationElapsed, setMinDurationElapsed] = useState(false);

  useEffect(() => {
    // Mark seen the first time the overlay renders so subsequent
    // launches get the quick variant. Wrapped to survive private-mode
    // storage failures.
    try {
      window.localStorage.setItem(SEEN_KEY, '1');
    } catch {
      // ignore
    }
  }, []);

  // First-launch only: incrementally reveal terminal lines.
  useEffect(() => {
    if (!firstLaunch) return;
    if (phase !== 'playing') return;
    if (linesShown >= BOOT_LINES.length) return;
    const t = setTimeout(() => setLinesShown((n) => n + 1), 240);
    return () => clearTimeout(t);
  }, [firstLaunch, phase, linesShown]);

  // Minimum on-screen duration so the animation doesn't flicker on a
  // fast boot. After elapses, we check `ready` to start the fade.
  useEffect(() => {
    const ms = firstLaunch ? FIRST_LAUNCH_MIN_MS : QUICK_LAUNCH_MIN_MS;
    const t = setTimeout(() => setMinDurationElapsed(true), ms);
    return () => clearTimeout(t);
  }, [firstLaunch]);

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
      className={`boot-overlay${phase === 'fading' ? ' boot-overlay--fading' : ''}${
        firstLaunch ? ' boot-overlay--full' : ' boot-overlay--quick'
      }`}
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
        {firstLaunch && (
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
        )}
      </div>
    </div>
  );
}
