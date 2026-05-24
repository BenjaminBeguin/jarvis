import { useEffect, useState } from 'react';

import { loadAuth } from './auth';
import './mobile.css';
import { MobileShell } from './MobileShell';
import type { MobileAuth, MobileView } from './types';

/**
 * Mobile PWA root. Reads auth from localStorage; if absent
 * renders a placeholder until the pairing screen lands in the
 * next commit. Otherwise hands off to MobileShell.
 *
 * Sub-views are picked from the URL query (`?view=inbox`,
 * `?view=conversation&id=<taskId>`, …) so iOS Safari handles
 * deep links + tab restoration the same way the desktop hash
 * router does.
 */
export function MobileApp() {
  const [auth, setAuth] = useState<MobileAuth | null>(() => loadAuth());
  const [view, setView] = useState<MobileView>(() => readViewFromHash());
  const [conversationId, setConversationId] = useState<string | null>(() =>
    readConversationIdFromHash(),
  );

  useEffect(() => {
    const onHash = (): void => {
      setView(readViewFromHash());
      setConversationId(readConversationIdFromHash());
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  if (!auth) {
    return (
      <div className="mobile-bootstrap">
        <div className="mobile-bootstrap__brand">◢ JARVIS</div>
        <p>Pairing screen lands here. Scan the QR from Settings → Mobile on your Mac.</p>
      </div>
    );
  }

  return (
    <MobileShell
      auth={auth}
      view={view}
      conversationId={conversationId}
      onSignOut={() => setAuth(null)}
    />
  );
}

function readViewFromHash(): MobileView {
  const hash = window.location.hash.replace(/^#/, '');
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return 'inbox';
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const view = params.get('view');
  if (
    view === 'inbox' ||
    view === 'conversations' ||
    view === 'conversation' ||
    view === 'dictate'
  ) {
    return view;
  }
  return 'inbox';
}

function readConversationIdFromHash(): string | null {
  const hash = window.location.hash.replace(/^#/, '');
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return null;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  return params.get('id');
}

/** Mutate the hash to navigate to a sub-view. Exported so other
 *  mobile components can call it without re-reading hash logic. */
export function navigateMobile(
  view: MobileView,
  extra?: Record<string, string>,
): void {
  const params = new URLSearchParams({ view, ...(extra ?? {}) });
  window.location.hash = `/mobile?${params.toString()}`;
}
