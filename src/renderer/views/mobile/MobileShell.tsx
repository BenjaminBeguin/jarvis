import { navigateMobile } from './MobileApp';
import type { MobileAuth, MobileView } from './types';

interface Props {
  auth: MobileAuth;
  view: MobileView;
  conversationId: string | null;
  onSignOut: () => void;
}

/**
 * Mobile chrome: thin status header + tab bar. Sub-views are
 * rendered as placeholders for this commit — Inbox /
 * Conversations / Dictate land in their own commits. Header
 * snapshot data + SSE wiring also lands in a later commit; the
 * current shell just proves the routing works.
 */
export function MobileShell({ auth, view, conversationId, onSignOut }: Props) {
  return (
    <div className="mobile-shell">
      <header className="mobile-shell__header">
        <span className="mobile-shell__brand" aria-hidden>
          ◢
        </span>
        <span className="mobile-shell__title">JARVIS</span>
        <button
          type="button"
          className="mobile-shell__signout"
          onClick={onSignOut}
          aria-label="Sign out"
          title="Sign out"
        >
          ⏻
        </button>
      </header>

      <main className="mobile-shell__body">
        <Placeholder view={view} conversationId={conversationId} auth={auth} />
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

function Placeholder({
  view,
  conversationId,
  auth,
}: {
  view: MobileView;
  conversationId: string | null;
  auth: MobileAuth;
}) {
  const label =
    view === 'inbox'
      ? 'Inbox lands here.'
      : view === 'conversations'
        ? 'Conversations land here.'
        : view === 'conversation'
          ? `Conversation ${conversationId ?? '?'} renders here.`
          : 'Dictate orb lands here.';
  return (
    <div className="mobile-shell__placeholder">
      <h2>{label}</h2>
      <p>
        Paired with <code>{auth.baseUrl}</code>. The actual surface lands in the
        next commit.
      </p>
    </div>
  );
}
