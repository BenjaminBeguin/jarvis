import { useEffect, useLayoutEffect, useRef, useState } from 'react';

import type { AppMode, TaskStatus, TrayMenuState } from '../../shared/types';

/**
 * Custom tray-menu popover — opens under the macOS menu-bar icon
 * on left-click. Replaces the native context menu with the Jarvis
 * neon/mono aesthetic (cyan accent, glow on hover, status header
 * with live counts + spend). Right-clicking the tray icon still
 * shows the native menu as an accessibility fallback.
 *
 * Wire-up:
 *   - On mount: read TrayMenuState once, subscribe to changes.
 *   - On action click: fire the same IPC the native menu used,
 *     then call hideTrayMenu() so the popover dismisses.
 *   - Escape + clicking outside (handled by main via window.blur)
 *     also dismiss.
 */
export function TrayMenu() {
  const [state, setState] = useState<TrayMenuState | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.jarvis.trayMenuRead().then(setState);
    return window.jarvis.onTrayMenuStateChanged(setState);
  }, []);

  // Push the actual rendered height back to main so the BrowserWindow
  // fits its content tightly — no empty strip below the last item.
  useLayoutEffect(() => {
    if (!containerRef.current || !state) return;
    const h = containerRef.current.offsetHeight;
    void window.jarvis.resizeTrayMenu(h + 16);
  }, [state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') void window.jarvis.hideTrayMenu();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!state) {
    return <div className="tray-menu tray-menu--loading">…</div>;
  }

  return (
    <div className="tray-menu" ref={containerRef}>
      <TrayMenuHeader state={state} />
      {state.meeting?.active && (
        <>
          <Divider />
          <MeetingRow meeting={state.meeting} />
        </>
      )}
      {state.pinned.length > 0 && (
        <>
          <Divider label={`📌 Pinned · ${state.pinned.length}`} />
          {state.pinned.map((p) => (
            <PinnedRow key={p.taskId} pin={p} />
          ))}
        </>
      )}
      <Divider />
      <NavRow
        label="Observatory"
        glyph="◎"
        accel=""
        onClick={() => void openTab('observatory')}
      />
      <NavRow
        label="Inbox"
        glyph="✉"
        accel=""
        onClick={() => void openTab('inbox')}
      />
      <NavRow
        label="Routines"
        glyph="⏱"
        accel=""
        onClick={() => void openTab('routines')}
      />
      <Divider />
      <NavRow
        label="Palette"
        glyph="⌘"
        accel="⌘⇧J"
        onClick={() => void openPalette()}
      />
      <Divider />
      <ToggleRow
        label="AFK · mirror to phone"
        glyph="📡"
        checked={state.afk}
        onClick={() => void setAfk(!state.afk)}
      />
      <Divider label="Mode" />
      <ModeRow
        appMode={state.appMode}
        active="paused"
        label="Paused"
        glyph="⏸"
        hint="silence routines + scheduled actions"
      />
      <ModeRow
        appMode={state.appMode}
        active="running"
        label="Running"
        glyph="▶"
        hint="manual dispatch only"
      />
      <ModeRow
        appMode={state.appMode}
        active="autopilot"
        label="Autopilot"
        glyph="⚡"
        hint="act on incoming asks"
      />
      <Divider />
      <NavRow
        label="Quit Jarvis"
        glyph="⏻"
        accel=""
        onClick={() => void quitApp()}
        danger
      />
    </div>
  );
}

function TrayMenuHeader({ state }: { state: TrayMenuState }) {
  const bits: Array<{ label: string; value: string; tone?: 'accent' | 'warn' | 'bad' }> = [];
  if (state.runningTasks > 0) {
    bits.push({ label: 'running', value: `${state.runningTasks}`, tone: 'accent' });
  }
  if (state.awaitingReplies > 0) {
    bits.push({ label: 'awaiting', value: `${state.awaitingReplies}`, tone: 'warn' });
  }
  if (state.pendingReminders > 0) {
    bits.push({ label: 'scheduled', value: `${state.pendingReminders}` });
  }
  if (state.reducedConversations > 0) {
    bits.push({
      label: 'reduced',
      value: `${state.reducedConversations}`,
    });
  }
  if (state.todaySpendUsd > 0) {
    bits.push({
      label: 'today',
      value:
        state.todaySpendUsd >= 0.01
          ? `$${state.todaySpendUsd.toFixed(2)}`
          : `$${state.todaySpendUsd.toFixed(4)}`,
    });
  }
  return (
    <div className="tray-menu__header">
      <div className="tray-menu__header-brand">
        <span className="tray-menu__brand-glyph" aria-hidden>
          ◢
        </span>
        <span className="tray-menu__brand-text">JARVIS</span>
        <span className={`tray-menu__mode-pill tray-menu__mode-pill--${state.appMode}`}>
          {modeGlyph(state.appMode)} {state.appMode}
        </span>
      </div>
      {bits.length > 0 ? (
        <div className="tray-menu__header-stats">
          {bits.map((b) => (
            <span
              key={b.label}
              className={`tray-menu__stat${b.tone ? ` tray-menu__stat--${b.tone}` : ''}`}
            >
              <span className="tray-menu__stat-value">{b.value}</span>
              <span className="tray-menu__stat-label">{b.label}</span>
            </span>
          ))}
        </div>
      ) : (
        <div className="tray-menu__header-idle">Nothing in flight.</div>
      )}
    </div>
  );
}

function MeetingRow({
  meeting,
}: {
  meeting: NonNullable<TrayMenuState['meeting']>;
}) {
  const title = meeting.title?.trim() || 'Meeting';
  const display = title.length > 28 ? `${title.slice(0, 27)}…` : title;
  return (
    <div className="tray-menu__meeting" role="group" aria-label="Meeting recording">
      <div className="tray-menu__meeting-line">
        <span
          className={`tray-menu__meeting-dot${meeting.paused ? ' tray-menu__meeting-dot--paused' : ''}`}
          aria-hidden
        />
        <span className="tray-menu__meeting-label">
          {meeting.paused ? 'PAUSED' : 'RECORDING'}
        </span>
        <span className="tray-menu__meeting-title" title={title}>
          {display}
        </span>
      </div>
      <div className="tray-menu__meeting-actions">
        {meeting.paused ? (
          <button
            type="button"
            className="tray-menu__meeting-btn"
            onClick={() => void meetingControl('resume')}
            title="Resume recording"
          >
            ▶ Resume
          </button>
        ) : (
          <button
            type="button"
            className="tray-menu__meeting-btn"
            onClick={() => void meetingControl('pause')}
            title="Pause recording (audio chunks discarded until resume)"
          >
            ⏸ Pause
          </button>
        )}
        <button
          type="button"
          className="tray-menu__meeting-btn tray-menu__meeting-btn--primary"
          onClick={() => void meetingControl('finish')}
          title="Stop + save + auto-debrief"
        >
          ■ Finish
        </button>
        <button
          type="button"
          className="tray-menu__meeting-btn tray-menu__meeting-btn--danger"
          onClick={() => {
            if (window.confirm('Discard this recording?')) {
              void meetingControl('cancel');
            }
          }}
          title="Discard recording without saving"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function PinnedRow({
  pin,
}: {
  pin: TrayMenuState['pinned'][number];
}) {
  return (
    <button
      className="tray-menu__row tray-menu__row--pinned"
      onClick={() => void openPinned(pin.taskId)}
      title={`${pin.title} · ${pin.reduced ? 'reduced' : 'sidebar tab'}`}
    >
      <span
        className={`tray-menu__pinned-dot tray-menu__pinned-dot--${pin.status}`}
        aria-hidden
      />
      <span className="tray-menu__row-label">
        {pin.title.length > 32 ? `${pin.title.slice(0, 31)}…` : pin.title}
      </span>
      {pin.reduced && (
        <span className="tray-menu__row-trail">▸ chip</span>
      )}
    </button>
  );
}

function Divider({ label }: { label?: string }) {
  if (!label) return <div className="tray-menu__divider" aria-hidden />;
  return (
    <div className="tray-menu__section-label">
      <span>{label}</span>
      <div className="tray-menu__divider-line" aria-hidden />
    </div>
  );
}

function NavRow({
  label,
  glyph,
  accel,
  onClick,
  danger,
}: {
  label: string;
  glyph: string;
  accel: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      className={`tray-menu__row${danger ? ' tray-menu__row--danger' : ''}`}
      onClick={onClick}
    >
      <span className="tray-menu__row-glyph" aria-hidden>
        {glyph}
      </span>
      <span className="tray-menu__row-label">{label}</span>
      {accel && <span className="tray-menu__row-accel">{accel}</span>}
    </button>
  );
}

function ToggleRow({
  label,
  glyph,
  checked,
  onClick,
}: {
  label: string;
  glyph: string;
  checked: boolean;
  onClick: () => void;
}) {
  return (
    <button
      className={`tray-menu__row${checked ? ' tray-menu__row--on' : ''}`}
      onClick={onClick}
      role="switch"
      aria-checked={checked}
    >
      <span className="tray-menu__row-glyph" aria-hidden>
        {glyph}
      </span>
      <span className="tray-menu__row-label">{label}</span>
      <span
        className={`tray-menu__row-switch${checked ? ' tray-menu__row-switch--on' : ''}`}
        aria-hidden
      >
        <span className="tray-menu__row-switch-knob" />
      </span>
    </button>
  );
}

function ModeRow({
  appMode,
  active,
  label,
  glyph,
  hint,
}: {
  appMode: AppMode;
  active: AppMode;
  label: string;
  glyph: string;
  hint: string;
}) {
  const isOn = appMode === active;
  return (
    <button
      className={`tray-menu__row tray-menu__mode-row${isOn ? ' tray-menu__row--on' : ''}`}
      onClick={() => void setAppMode(active)}
      role="radio"
      aria-checked={isOn}
    >
      <span className="tray-menu__row-glyph" aria-hidden>
        {glyph}
      </span>
      <span className="tray-menu__mode-row-body">
        <span className="tray-menu__row-label">{label}</span>
        <span className="tray-menu__mode-row-hint">{hint}</span>
      </span>
      <span
        className={`tray-menu__mode-dot${isOn ? ' tray-menu__mode-dot--on' : ''}`}
        aria-hidden
      />
    </button>
  );
}

function modeGlyph(mode: AppMode): string {
  if (mode === 'paused') return '⏸';
  if (mode === 'autopilot') return '⚡';
  return '▶';
}

// --- Action helpers (wrap IPC + auto-hide on success) -----------------------

async function dismiss(): Promise<void> {
  await window.jarvis.hideTrayMenu();
}

async function openTab(
  tab: 'observatory' | 'inbox' | 'routines',
): Promise<void> {
  // Cross-window dispatch: window.dispatchEvent in the popup
  // doesn't reach the main window — go through main via the
  // openTab IPC which focuses the main window AND fires
  // shellNavigate to the correct tab.
  await window.jarvis.openTab(tab);
  await dismiss();
}

async function openPalette(): Promise<void> {
  await window.jarvis.openPalette();
  await dismiss();
}

async function openPinned(taskId: string): Promise<void> {
  // surfaceConversation in main handles the focused-vs-popup
  // branching. The renderer-side trigger is the conversationFocus
  // event which we route via the same openObservatory IPC flow
  // that the existing pinned-from-tray native menu used. The
  // observatory window's preload subscribes to shellNavigate +
  // observatoryFocusTask; for a conversation we use the
  // openObservatory taskId path which lands the conversation in
  // the sidebar.
  await window.jarvis.openObservatory(taskId);
  await dismiss();
}

async function setAfk(next: boolean): Promise<void> {
  await window.jarvis.setAfk(next);
}

async function setAppMode(mode: AppMode): Promise<void> {
  await window.jarvis.setAppMode(mode);
}

async function meetingControl(
  action: 'pause' | 'resume' | 'cancel' | 'finish',
): Promise<void> {
  await window.jarvis.meetingControlInvoke(action);
  // For Finish + Cancel, dismiss the popover — the recording state
  // changes (the row disappears) so leaving the menu open would
  // immediately re-render without it, which is fine, but the user
  // probably wants the menu out of their way after a terminal
  // action. Pause / Resume keeps the menu open so they can keep
  // adjusting.
  if (action === 'finish' || action === 'cancel') {
    await dismiss();
  }
}

async function quitApp(): Promise<void> {
  await dismiss();
  await window.jarvis.quitApp();
}
