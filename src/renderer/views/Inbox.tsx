import { useEffect, useMemo, useState } from 'react';

import type { InboxItem } from '../../shared/types';
import { toast } from './Toaster';

/**
 * Daily-driver triage view. Lists PRs to review, comments on your PRs,
 * reminders firing today, and failed routines — grouped by source, with a
 * 1-click action that dispatches the right skill. Refreshes on mount and
 * via the manual refresh button; future P3 standing-watches will keep it
 * fresh in the background.
 */
const ACTIVE_PROJECT_KEY = 'jarvis.activeProject';

function readActiveProject(): string | null {
  try {
    return window.localStorage.getItem(ACTIVE_PROJECT_KEY) || null;
  } catch {
    return null;
  }
}

export function Inbox() {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<string | null>(() =>
    readActiveProject(),
  );
  const [filterByScope, setFilterByScope] = useState(false);

  useEffect(() => {
    // 1. Fetch cached list immediately (instant render with stale data).
    void window.jarvis.listInbox().then(setItems);
    // 2. Then kick a fresh refresh in the background.
    void doRefresh();
    const offChanged = window.jarvis.onInboxChanged((next) => {
      setItems(next);
      setLastRefreshedAt(Date.now());
    });
    const offRefreshing = window.jarvis.onInboxRefreshing(setRefreshing);
    return () => {
      offChanged();
      offRefreshing();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Track active project changes — same wiring as the palette uses.
  useEffect(() => {
    const sync = () => setActiveProject(readActiveProject());
    sync();
    const onChange = (e: Event) => {
      const detail = (e as CustomEvent).detail as { project: string | null };
      setActiveProject(detail?.project ?? null);
    };
    window.addEventListener('jarvis:active-project-changed', onChange);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener('jarvis:active-project-changed', onChange);
      window.removeEventListener('storage', sync);
    };
  }, []);

  // Reset the filter toggle when scope clears — the toggle only makes
  // sense when there's something to filter by.
  useEffect(() => {
    if (!activeProject) setFilterByScope(false);
  }, [activeProject]);

  const doRefresh = async () => {
    setError(null);
    try {
      await window.jarvis.refreshInbox();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const filteredItems = useMemo(() => {
    if (!filterByScope || !activeProject) return items;
    return items.filter((it) => it.project === activeProject);
  }, [items, filterByScope, activeProject]);

  const grouped = useMemo(() => groupBySource(filteredItems), [filteredItems]);
  const hiddenCount = items.length - filteredItems.length;

  return (
    <section className="inbox">
      <header className="inbox__head">
        <div>
          <h2>INBOX</h2>
          <div className="inbox__hint">
            {items.length === 0 && !refreshing
              ? 'Nothing waiting on you.'
              : `${filteredItems.length} of ${items.length} item${items.length === 1 ? '' : 's'}${
                  lastRefreshedAt
                    ? ` · refreshed ${formatRelative(lastRefreshedAt)}`
                    : ''
                }`}
          </div>
        </div>
        <div className="inbox__head-actions">
          {activeProject && (
            <button
              className={`inbox__scope-filter${filterByScope ? ' inbox__scope-filter--on' : ''}`}
              onClick={() => setFilterByScope((v) => !v)}
              title={
                filterByScope
                  ? `Showing only "${activeProject}" items. Click to show all.`
                  : `Filter to "${activeProject}" items only.`
              }
            >
              {filterByScope ? `✓ ${activeProject}` : `Filter: ${activeProject}`}
            </button>
          )}
          <button
            className="inbox__refresh"
            onClick={() => void doRefresh()}
            disabled={refreshing}
            title="Re-run every inbox source"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>
      {filterByScope && hiddenCount > 0 && (
        <div className="inbox__hint inbox__filter-hint">
          {hiddenCount} item{hiddenCount === 1 ? '' : 's'} hidden (not tagged
          with project · only PR sources tag items today; user-defined
          sources can set <code>project</code> per item).
        </div>
      )}

      {error && <div className="inbox__error">{error}</div>}

      {items.length === 0 && refreshing && (
        <div className="inbox__empty">Looking around…</div>
      )}

      {items.length === 0 && !refreshing && !error && (
        <div className="inbox__empty">
          You're caught up. The inbox aggregates PRs, comments, reminders,
          and failed routines.
        </div>
      )}

      {grouped.map(({ source, label, items: rows }) => (
        <section key={source} className="inbox__group">
          <h3 className="inbox__group-head">
            {label} <span className="inbox__group-count">{rows.length}</span>
          </h3>
          <ul className="inbox__list">
            {rows.map((item) => (
              <InboxRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

function InboxRow({ item }: { item: InboxItem }) {
  const [acting, setActing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const act = async () => {
    if (!item.action) return;
    setActing(true);
    try {
      const summary = await window.jarvis.launchTask({
        prompt: item.action.prompt,
        skillId: item.action.skillId,
        origin: 'palette',
      });
      void window.jarvis.showAnswerHud(summary.id);
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setActing(false);
    }
  };

  const open = () => {
    if (!item.url) return;
    void window.jarvis.openExternal(item.url);
  };

  const dismissFor = async (snoozeMs: number, label: string) => {
    try {
      await window.jarvis.dismissInboxItem(item.id, snoozeMs);
      toast({ message: `Snoozed · ${label}` });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setMenuOpen(false);
    }
  };

  return (
    <li className="inbox__row">
      <div className="inbox__row-main">
        <div className="inbox__row-title">{item.title}</div>
        {item.subtitle && <div className="inbox__row-sub">{item.subtitle}</div>}
      </div>
      <div className="inbox__row-meta">
        {item.fireAt != null && (
          <span className="inbox__row-when" title={new Date(item.fireAt).toLocaleString()}>
            {formatFireAt(item.fireAt)}
          </span>
        )}
        {item.fireAt == null && (
          <span className="inbox__row-when" title={new Date(item.createdAt).toLocaleString()}>
            {formatRelative(item.createdAt)}
          </span>
        )}
      </div>
      <div className="inbox__row-actions">
        {item.url && (
          <button className="inbox__row-link" onClick={open} title={item.url}>
            Open
          </button>
        )}
        {item.action && (
          <button
            className="inbox__row-primary"
            onClick={() => void act()}
            disabled={acting}
            title={item.action.skillId ? `Launches ${item.action.skillId}` : item.action.prompt}
          >
            {acting ? 'Launching…' : item.action.label}
          </button>
        )}
        <div className="inbox__row-dismiss">
          <button
            className="inbox__row-dismiss-btn"
            onClick={() => setMenuOpen((v) => !v)}
            title="Snooze or dismiss this item"
          >
            💤
          </button>
          {menuOpen && (
            <div
              className="inbox__row-dismiss-menu"
              onMouseLeave={() => setMenuOpen(false)}
            >
              <button onClick={() => void dismissFor(1 * 60 * 60 * 1000, '1h')}>
                1 hour
              </button>
              <button onClick={() => void dismissFor(4 * 60 * 60 * 1000, '4h')}>
                4 hours
              </button>
              <button onClick={() => void dismissFor(24 * 60 * 60 * 1000, '1 day')}>
                Tomorrow
              </button>
              <button onClick={() => void dismissFor(7 * 24 * 60 * 60 * 1000, '1 week')}>
                Next week
              </button>
              <button
                className="inbox__row-dismiss-menu-forever"
                onClick={() => void dismissFor(4_102_444_800_000, 'forever')}
              >
                Dismiss forever
              </button>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

interface Group {
  source: string;
  label: string;
  items: InboxItem[];
}

/** Stable section order. Reminders first (time-sensitive), then PRs, then
 *  the rest. New sources fall through to the bottom alphabetically. */
const SOURCE_ORDER: Record<string, { rank: number; label: string }> = {
  reminders: { rank: 0, label: 'Scheduled' },
  'pr-review': { rank: 1, label: 'PRs awaiting your review' },
  'pr-comments': { rank: 2, label: 'Comments on your PRs' },
  'failed-routines': { rank: 3, label: 'Needs attention' },
};

function groupBySource(items: InboxItem[]): Group[] {
  const byKey = new Map<string, Group>();
  for (const item of items) {
    const meta = SOURCE_ORDER[item.source];
    const label = meta?.label ?? item.source;
    let g = byKey.get(item.source);
    if (!g) {
      g = { source: item.source, label, items: [] };
      byKey.set(item.source, g);
    }
    g.items.push(item);
  }
  return Array.from(byKey.values()).sort((a, b) => {
    const ra = SOURCE_ORDER[a.source]?.rank ?? 999;
    const rb = SOURCE_ORDER[b.source]?.rank ?? 999;
    if (ra !== rb) return ra - rb;
    return a.label.localeCompare(b.label);
  });
}

function formatFireAt(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return 'now';
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'in <1m';
  if (m < 60) return `in ${m}m`;
  const h = m / 60;
  if (h < 24) return `in ${Math.round(h * 10) / 10}h`;
  return new Date(ts).toLocaleString(undefined, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
  });
}
