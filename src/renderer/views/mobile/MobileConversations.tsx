import { useEffect, useState } from 'react';

import type { TaskSummary, TrayMenuState } from '../../../shared/types';
import { api } from './api';
import { navigateMobile } from './MobileApp';
import { useSse } from './useSse';
import type { MobileAuth } from './types';

interface Props {
  auth: MobileAuth;
  status: TrayMenuState | null;
}

/**
 * List of recent task threads. Pinned items (from the live
 * status snapshot) ride above the rest so the conversations
 * the user flagged for tracking stay at the top.
 *
 * Tap a row → navigates to /mobile?view=conversation&id=<taskId>,
 * which mounts MobileConversation.
 */
export function MobileConversations({ auth, status }: Props) {
  const [tasks, setTasks] = useState<TaskSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async (): Promise<void> => {
    setRefreshing(true);
    setError(null);
    try {
      const list = await api<TaskSummary[]>(auth, '/v1/tasks');
      setTasks(list);
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

  // Refetch when any task transitions status — keeps the list
  // mostly current without polling.
  useSse(auth, {
    onTaskStatus: () => {
      void refresh();
    },
  });

  const pinned = status?.pinned ?? [];
  const pinnedIds = new Set(pinned.map((p) => p.taskId));
  const recent = tasks
    ? tasks.filter((t) => !pinnedIds.has(t.id)).slice(0, 30)
    : null;

  return (
    <div className="mobile-convos">
      <header className="mobile-convos__head">
        <h2>THREADS</h2>
        <button
          type="button"
          className="mobile-inbox__refresh"
          onClick={() => void refresh()}
          disabled={refreshing}
          aria-label="Refresh threads"
        >
          {refreshing ? '…' : '↻'}
        </button>
      </header>
      {error && <div className="mobile-inbox__error">{error}</div>}
      {pinned.length > 0 && (
        <>
          <div className="mobile-convos__section">📌 Pinned</div>
          <ul className="mobile-convos__list">
            {pinned.map((p) => (
              <li key={p.taskId}>
                <button
                  type="button"
                  className="mobile-convos__row"
                  onClick={() =>
                    navigateMobile('conversation', { id: p.taskId })
                  }
                >
                  <span
                    className={`mobile-convos__dot mobile-convos__dot--${p.status}`}
                    aria-hidden
                  />
                  <span className="mobile-convos__title">{p.title}</span>
                  <span className="mobile-convos__meta">{p.status}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {recent === null && pinned.length === 0 && !error && (
        <div className="mobile-inbox__empty">Loading…</div>
      )}
      {recent && (
        <>
          {pinned.length > 0 && (
            <div className="mobile-convos__section">Recent</div>
          )}
          {recent.length === 0 && pinned.length === 0 && (
            <div className="mobile-inbox__empty">No threads yet.</div>
          )}
          <ul className="mobile-convos__list">
            {recent.map((t) => (
              <li key={t.id}>
                <button
                  type="button"
                  className="mobile-convos__row"
                  onClick={() =>
                    navigateMobile('conversation', { id: t.id })
                  }
                >
                  <span
                    className={`mobile-convos__dot mobile-convos__dot--${t.awaitingInput && t.status === 'running' ? 'awaiting' : t.status}`}
                    aria-hidden
                  />
                  <span className="mobile-convos__title">{t.title}</span>
                  <span className="mobile-convos__meta">
                    {t.status === 'running' && t.awaitingInput
                      ? 'awaiting'
                      : t.status}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
