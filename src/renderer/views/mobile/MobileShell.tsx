import { useEffect, useState } from 'react';

import type { TrayMenuState } from '../../../shared/types';
import { api } from './api';
import { MobileConversation } from './MobileConversation';
import { MobileConversations } from './MobileConversations';
import { MobileDictate } from './MobileDictate';
import { MobileHelp } from './MobileHelp';
import { MobileInbox } from './MobileInbox';
import { navigateMobile } from './MobileApp';
import { useSse } from './useSse';
import type { MobileAuth, MobileView } from './types';

interface Props {
  auth: MobileAuth;
  view: MobileView;
  conversationId: string | null;
  onSignOut: () => void;
}

/**
 * Mobile chrome: live status header + tab bar + view body. Holds
 * the SSE connection so the header updates without each view
 * mounting its own subscription. `MobileInbox` etc. subscribe
 * INDEPENDENTLY to the events they care about — SSE multiplex
 * fan-out happens inside useSse.
 */
interface RecordingState {
  active: boolean;
  paused: boolean;
  title: string | null;
  startedAt: number | null;
}

const EMPTY_RECORDING: RecordingState = {
  active: false,
  paused: false,
  title: null,
  startedAt: null,
};

export function MobileShell({ auth, view, conversationId, onSignOut }: Props) {
  const [status, setStatus] = useState<TrayMenuState | null>(null);
  const [recording, setRecording] = useState<RecordingState>(EMPTY_RECORDING);

  // Initial fetch — populates the header before SSE delivers the
  // first 'status' event.
  useEffect(() => {
    void api<TrayMenuState>(auth, '/v1/status/details')
      .then(setStatus)
      .catch(() => {
        /* will be retried on next SSE status tick */
      });
    // Same for the recording snapshot — paint the banner immediately
    // when the phone opens to a Mac that's already mid-meeting.
    void api<RecordingState>(auth, '/v1/meeting/state')
      .then(setRecording)
      .catch(() => {
        /* SSE will catch us up */
      });
  }, [auth.baseUrl, auth.token]);

  const { connected } = useSse(auth, {
    onStatus: (payload) => {
      setStatus(payload as TrayMenuState);
    },
    onMeetingState: (payload) => {
      setRecording(payload as RecordingState);
    },
  });

  return (
    <div className="mobile-shell">
      <Header status={status} connected={connected} />
      {recording.active && (
        <RecordingBanner auth={auth} state={recording} />
      )}
      <main className="mobile-shell__body">
        <ViewBody
          view={view}
          auth={auth}
          conversationId={conversationId}
          status={status}
          onSignOut={onSignOut}
        />
      </main>
      <nav className="mobile-shell__tabs">
        <TabButton view="inbox" active={view} label="Inbox" glyph="✉" />
        <TabButton
          view="conversations"
          active={view === 'conversation' ? 'conversations' : view}
          label="Threads"
          glyph="◐"
        />
        <TabButton view="dictate" active={view} label="Dictate" glyph="🎙" />
      </nav>
    </div>
  );
}

/**
 * Banner under the header when a meeting recording is active on the
 * Mac. Shows the meeting title + an audible-elapsed clock (computed
 * from startedAt — no server-side counter needed). Tap to reveal
 * remote-control buttons (Pause/Resume + Finish + Cancel). All four
 * actions POST to /v1/meeting/control and the Mac's renderer
 * dispatches to the local MeetingRecorder.
 */
function RecordingBanner({
  auth,
  state,
}: {
  auth: MobileAuth;
  state: RecordingState;
}) {
  const [expanded, setExpanded] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [acting, setActing] = useState<string | null>(null);

  useEffect(() => {
    if (!state.active || state.paused) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state.active, state.paused]);

  const send = async (
    action: 'pause' | 'resume' | 'cancel' | 'finish',
  ): Promise<void> => {
    if (acting) return;
    if (action === 'cancel') {
      const ok = window.confirm(
        'Discard the recording? No transcript will be saved.',
      );
      if (!ok) return;
    }
    setActing(action);
    try {
      await api<{ ok: boolean }>(auth, '/v1/meeting/control', {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
    } catch {
      /* SSE will reflect the next state — no need to surface here. */
    } finally {
      setActing(null);
    }
  };

  const elapsedMs = state.startedAt
    ? Math.max(0, now - state.startedAt)
    : 0;
  const elapsedLabel = formatRecLabel(elapsedMs);

  return (
    <div
      className={`mobile-rec${state.paused ? ' mobile-rec--paused' : ''}${expanded ? ' mobile-rec--expanded' : ''}`}
    >
      <button
        type="button"
        className="mobile-rec__bar"
        onClick={() => setExpanded((v) => !v)}
        aria-label="Show recording controls"
      >
        <span className="mobile-rec__dot" aria-hidden>
          {state.paused ? '⏸' : '🔴'}
        </span>
        <span className="mobile-rec__title">
          {state.title ?? 'Recording'}
        </span>
        <span className="mobile-rec__time">
          {state.paused ? 'paused' : elapsedLabel}
        </span>
        <span className="mobile-rec__chev" aria-hidden>
          {expanded ? '▾' : '▸'}
        </span>
      </button>
      {expanded && (
        <div className="mobile-rec__controls">
          {state.paused ? (
            <button
              type="button"
              className="mobile-rec__btn"
              onClick={() => void send('resume')}
              disabled={!!acting}
            >
              {acting === 'resume' ? '…' : '▶ Resume'}
            </button>
          ) : (
            <button
              type="button"
              className="mobile-rec__btn"
              onClick={() => void send('pause')}
              disabled={!!acting}
            >
              {acting === 'pause' ? '…' : '❚❚ Pause'}
            </button>
          )}
          <button
            type="button"
            className="mobile-rec__btn mobile-rec__btn--primary"
            onClick={() => void send('finish')}
            disabled={!!acting}
          >
            {acting === 'finish' ? '…' : 'Finish'}
          </button>
          <button
            type="button"
            className="mobile-rec__btn mobile-rec__btn--danger"
            onClick={() => void send('cancel')}
            disabled={!!acting}
          >
            {acting === 'cancel' ? '…' : '✕'}
          </button>
        </div>
      )}
    </div>
  );
}

function formatRecLabel(ms: number): string {
  const t = Math.floor(ms / 1000);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = t % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function Header({
  status,
  connected,
}: {
  status: TrayMenuState | null;
  connected: boolean;
}) {
  const modeGlyph =
    status?.appMode === 'paused'
      ? '⏸'
      : status?.appMode === 'autopilot'
        ? '⚡'
        : '▶';
  return (
    <header className="mobile-shell__header">
      <span className="mobile-shell__brand" aria-hidden>
        ◢
      </span>
      <span className="mobile-shell__title">JARVIS</span>
      {status && (
        <span
          className={`mobile-shell__mode mobile-shell__mode--${status.appMode}`}
          title={`Mode: ${status.appMode}`}
        >
          {modeGlyph} {status.appMode}
        </span>
      )}
      <span
        className={`mobile-shell__link${connected ? ' mobile-shell__link--on' : ''}`}
        title={connected ? 'Live updates' : 'Reconnecting…'}
        aria-hidden
      />
      <button
        type="button"
        className="mobile-shell__signout"
        onClick={() => navigateMobile('help')}
        aria-label="Help and setup"
        title="Help & setup"
      >
        ?
      </button>
      {status && <StatChips status={status} />}
    </header>
  );
}

function StatChips({ status }: { status: TrayMenuState }) {
  const chips: Array<{ label: string; value: string; tone?: 'accent' | 'warn' }> = [];
  if (status.runningTasks > 0) {
    chips.push({ label: 'running', value: String(status.runningTasks), tone: 'accent' });
  }
  if (status.awaitingReplies > 0) {
    chips.push({ label: 'awaiting', value: String(status.awaitingReplies), tone: 'warn' });
  }
  if (status.pendingReminders > 0) {
    chips.push({ label: 'scheduled', value: String(status.pendingReminders) });
  }
  if (status.todaySpendUsd > 0) {
    chips.push({
      label: 'today',
      value:
        status.todaySpendUsd >= 0.01
          ? `$${status.todaySpendUsd.toFixed(2)}`
          : `$${status.todaySpendUsd.toFixed(4)}`,
    });
  }
  if (chips.length === 0) return null;
  return (
    <div className="mobile-shell__chips">
      {chips.map((c) => (
        <span
          key={c.label}
          className={`mobile-shell__chip${c.tone ? ` mobile-shell__chip--${c.tone}` : ''}`}
        >
          <span className="mobile-shell__chip-value">{c.value}</span>
          <span className="mobile-shell__chip-label">{c.label}</span>
        </span>
      ))}
    </div>
  );
}

function ViewBody({
  view,
  auth,
  conversationId,
  status,
  onSignOut,
}: {
  view: MobileView;
  auth: MobileAuth;
  conversationId: string | null;
  status: TrayMenuState | null;
  onSignOut: () => void;
}) {
  if (view === 'inbox') return <MobileInbox auth={auth} />;
  if (view === 'conversations')
    return <MobileConversations auth={auth} status={status} />;
  if (view === 'conversation' && conversationId)
    return <MobileConversation auth={auth} taskId={conversationId} />;
  if (view === 'dictate') return <MobileDictate auth={auth} />;
  if (view === 'help') return <MobileHelp auth={auth} onSignOut={onSignOut} />;
  return (
    <div className="mobile-shell__placeholder">
      <h2>Pick a thread first.</h2>
      <p>
        Paired with <code>{auth.baseUrl}</code>
        {status && <> · mode: {status.appMode}</>}
      </p>
    </div>
  );
}

function TabButton({
  view,
  active,
  label,
  glyph,
}: {
  view: MobileView;
  active: MobileView;
  label: string;
  glyph: string;
}) {
  const isActive = active === view;
  return (
    <button
      type="button"
      className={`mobile-shell__tab${isActive ? ' mobile-shell__tab--active' : ''}`}
      onClick={() => navigateMobile(view)}
    >
      <span className="mobile-shell__tab-glyph" aria-hidden>
        {glyph}
      </span>
      <span className="mobile-shell__tab-label">{label}</span>
    </button>
  );
}
