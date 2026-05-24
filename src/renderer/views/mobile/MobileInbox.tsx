import { useEffect, useState } from 'react';

import type { InboxItem } from '../../../shared/types';
import { api } from './api';
import { useSse } from './useSse';
import type { MobileAuth } from './types';

interface Props {
  auth: MobileAuth;
}

/**
 * Mobile Inbox surface. Initial fetch on mount, then refreshes
 * when the SSE stream pushes `notif` events tagged with the
 * `inbox-new` source — Inbox is small enough that re-fetching
 * the whole list is cheaper than reconciling deltas.
 */
export function MobileInbox({ auth }: Props) {
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      const list = await api<InboxItem[]>(auth, '/v1/inbox');
      setItems(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.baseUrl, auth.token]);

  useSse(auth, {
    onNotif: (payload) => {
      const e = payload as { source?: string } | null;
      if (e?.source === 'inbox-new') void refresh();
    },
  });

  return (
    <div className="mobile-inbox">
      <header className="mobile-inbox__head">
        <h2>INBOX</h2>
        <button
          type="button"
          className="mobile-inbox__refresh"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label="Refresh inbox"
        >
          {refreshing ? '…' : '↻'}
        </button>
      </header>
      {error && <div className="mobile-inbox__error">{error}</div>}
      {items === null && !error && (
        <div className="mobile-inbox__empty">Loading…</div>
      )}
      {items && items.length === 0 && (
        <div className="mobile-inbox__empty">
          Nothing waiting on you.
        </div>
      )}
      {items && items.length > 0 && (
        <ul className="mobile-inbox__list">
          {items.map((it) => (
            <li key={it.id} className="mobile-inbox__row">
              <span className="mobile-inbox__source">{it.source}</span>
              <a
                href={it.url}
                target="_blank"
                rel="noopener noreferrer"
                className="mobile-inbox__title"
              >
                {it.title}
              </a>
              {it.subtitle && (
                <span className="mobile-inbox__subtitle">{it.subtitle}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
