import { useEffect, useState } from 'react';

import type { TrayMenuState } from '../../../shared/types';
import { api } from './api';
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
export function MobileShell({ auth, view, conversationId, onSignOut }: Props) {
  const [status, setStatus] = useState<TrayMenuState | null>(null);

  // Initial fetch — populates the header before SSE delivers the
  // first 'status' event.
  useEffect(() => {
    void api<TrayMenuState>(auth, '/v1/status/details')
      .then(setStatus)
      .catch(() => {
        /* will be retried on next SSE status tick */
      });
  }, [auth.baseUrl, auth.token]);

  const { connected } = useSse(auth, {
    onStatus: (payload) => {
      setStatus(payload as TrayMenuState);
    },
  });

  return (
    <div className="mobile-shell">
      <Header status={status} connected={connected} onSignOut={onSignOut} />
      <main className="mobile-shell__body">
        <ViewBody
          view={view}
          auth={auth}
          conversationId={conversationId}
          status={status}
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

function Header({
  status,
  connected,
  onSignOut,
}: {
  status: TrayMenuState | null;
  connected: boolean;
  onSignOut: () => void;
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
        onClick={onSignOut}
        aria-label="Sign out"
        title="Sign out"
      >
        ⏻
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
}: {
  view: MobileView;
  auth: MobileAuth;
  conversationId: string | null;
  status: TrayMenuState | null;
}) {
  if (view === 'inbox') return <MobileInbox auth={auth} />;
  return (
    <div className="mobile-shell__placeholder">
      <h2>
        {view === 'conversations'
          ? 'Conversations land here.'
          : view === 'conversation'
            ? `Conversation ${conversationId ?? '?'} renders here.`
            : 'Dictate orb lands here.'}
      </h2>
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
