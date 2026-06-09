import { useEffect, useState } from 'react';

import type { AppMode } from '../../../shared/types';

/**
 * SystemStatus — Iron-Man "all systems nominal" pill row.
 *
 * Top-right of the Bridge header. Three live indicators:
 *
 *   - **MODE** (RUN / AUTO / PAUSE) — driven by appMode.
 *     - RUN  → green dot, normal Jarvis behaviour
 *     - AUTO → magenta dot pulsing, autopilot workflows can fire
 *     - PAUSE → amber dot static, all automated work suppressed
 *
 *   - **AFK** — when on, dims active dispatches + suppresses notifs.
 *     Shown only when ON so the indicator strip stays uncluttered
 *     during normal use.
 *
 *   - **PAUSED** — explicit pause flag (separate from AFK). Same:
 *     only shown when on.
 *
 * Click MODE → cycles RUN ↔ AUTO. Single-click toggle so the user
 * can flip autopilot on/off from the Bridge without a settings hop.
 *
 * The indicators sit inside HUD brackets and use the same accent
 * tones as the rest of the Bridge — keeps the visual vocabulary
 * unified.
 */

export function SystemStatus() {
  const [appMode, setAppMode] = useState<AppMode>('running');
  const [paused, setPaused] = useState(false);
  const [afk, setAfk] = useState(false);

  useEffect(() => {
    void window.jarvis.getAppMode().then(setAppMode);
    return window.jarvis.onAppModeChanged(setAppMode);
  }, []);

  useEffect(() => {
    void window.jarvis.getPaused().then(setPaused);
    return window.jarvis.onPausedChanged(setPaused);
  }, []);

  useEffect(() => {
    void window.jarvis.getAfk().then(setAfk);
    return window.jarvis.onAfkChanged(setAfk);
  }, []);

  const cycleMode = (): void => {
    const next: AppMode = appMode === 'autopilot' ? 'running' : 'autopilot';
    void window.jarvis.setAppMode(next);
  };

  return (
    <div className="bridge-status" role="status" aria-label="System status">
      <button
        type="button"
        className={`bridge-status__pill bridge-status__pill--${appMode}`}
        onClick={cycleMode}
        title={
          appMode === 'autopilot'
            ? 'Autopilot on — click to switch to manual'
            : appMode === 'paused'
              ? 'Globally paused'
              : 'Manual mode — click to engage autopilot'
        }
      >
        <span className="bridge-status__dot" aria-hidden />
        <span className="bridge-status__label">
          {appMode === 'autopilot' ? 'AUTO' : appMode === 'paused' ? 'PAUSE' : 'RUN'}
        </span>
      </button>
      {paused && (
        <span className="bridge-status__pill bridge-status__pill--paused" title="Paused">
          <span className="bridge-status__dot" aria-hidden />
          <span className="bridge-status__label">PAUSED</span>
        </span>
      )}
      {afk && (
        <span className="bridge-status__pill bridge-status__pill--afk" title="Away — notifications suppressed">
          <span className="bridge-status__dot" aria-hidden />
          <span className="bridge-status__label">AFK</span>
        </span>
      )}
    </div>
  );
}
