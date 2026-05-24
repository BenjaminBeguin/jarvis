import { useEffect, useState } from 'react';

import { clearAuth, loadAuth, saveAuth } from './auth';
import './mobile.css';
import { MobileLogin } from './MobileLogin';
import { MobileShell } from './MobileShell';
import type { MobileAuth, MobileView } from './types';

/**
 * Mobile PWA root. Three phases:
 *
 *   1. URL-encoded pair payload (?pair=base64-json) → save it,
 *      strip from URL, render MobileShell. This is the path
 *      taken right after scanning the desktop QR.
 *   2. Auth already in localStorage → render MobileShell.
 *   3. Neither → render MobileLogin (paste-the-URL fallback).
 *
 * Sub-views are picked from the URL query (`?view=inbox`,
 * `?view=conversation&id=<taskId>`, …) so iOS Safari handles
 * deep links + tab restoration the same way the desktop hash
 * router does.
 */
export function MobileApp() {
  // Consume ?pair=… BEFORE the first paint so the URL is clean
  // by the time the user looks at it. saveAuth happens here too.
  const initialAuth = consumePairPayload() ?? loadAuth();
  const [auth, setAuth] = useState<MobileAuth | null>(initialAuth);
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
      <MobileLogin
        onPaired={(a) => {
          saveAuth(a);
          setAuth(a);
        }}
      />
    );
  }

  return (
    <MobileShell
      auth={auth}
      view={view}
      conversationId={conversationId}
      onSignOut={() => {
        clearAuth();
        setAuth(null);
      }}
    />
  );
}

/**
 * Decode `?pair=<base64-json>` from the URL hash, save it, and
 * scrub the param from the URL so the QR payload doesn't sit
 * around in browser history. Returns the parsed auth or null.
 */
function consumePairPayload(): MobileAuth | null {
  const hash = window.location.hash.replace(/^#/, '');
  const qIdx = hash.indexOf('?');
  if (qIdx === -1) return null;
  const params = new URLSearchParams(hash.slice(qIdx + 1));
  const pair = params.get('pair');
  if (!pair) return null;
  let parsed: MobileAuth | null = null;
  try {
    const raw = atob(pair);
    const obj = JSON.parse(raw) as Partial<MobileAuth>;
    if (
      typeof obj?.baseUrl === 'string' &&
      typeof obj?.token === 'string' &&
      obj.baseUrl &&
      obj.token
    ) {
      parsed = { baseUrl: obj.baseUrl, token: obj.token };
    }
  } catch {
    return null;
  }
  if (parsed) {
    saveAuth(parsed);
    // Strip the pair param + leave the rest of the hash intact.
    params.delete('pair');
    const rest = params.toString();
    const base = hash.slice(0, qIdx);
    window.location.hash = rest ? `${base}?${rest}` : base;
  }
  return parsed;
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
