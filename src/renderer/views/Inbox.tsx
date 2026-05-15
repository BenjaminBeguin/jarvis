import { useEffect, useMemo, useState } from 'react';

import type { InboxItem } from '../../shared/types';
import { TaskBindingBadge } from './TaskBindingBadge';
import { toast } from './Toaster';
import { useTaskBinding, type TaskBindingState } from './useTaskBinding';

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

/**
 * @param compact - when true, hides the redundant "INBOX" title.
 * Used when the component is embedded inside a Dashboard section
 * (which already carries the section title).
 */
export function Inbox({ compact = false }: { compact?: boolean } = {}) {
  const [items, setItems] = useState<InboxItem[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<string | null>(() =>
    readActiveProject(),
  );
  const [filterByScope, setFilterByScope] = useState(false);
  const bindings = useTaskBinding('inbox');

  // Drop bindings for items that are no longer in the inbox.
  // The accuracy filter (PR replied to / resolved) makes items vanish
  // on refresh; their bindings would otherwise pile up forever.
  useEffect(() => {
    if (items.length === 0) return;
    bindings.retainKeys(new Set(items.map((it) => it.id)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

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

  /**
   * Snooze every currently-visible item — useful after a triage pass
   * when you want a clean slate until tomorrow. Respects the scope
   * filter (only snoozes filtered items).
   */
  const bulkDismiss = async (label: string) => {
    if (filteredItems.length === 0) return;
    const snoozeMs = 24 * 60 * 60 * 1000;
    if (
      !confirm(
        `Snooze ${filteredItems.length} item${filteredItems.length === 1 ? '' : 's'} for ${label}?`,
      )
    )
      return;
    try {
      await Promise.all(
        filteredItems.map((it) =>
          window.jarvis.dismissInboxItem(it.id, snoozeMs),
        ),
      );
      toast({ message: `Snoozed ${filteredItems.length} for ${label}` });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
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
          {!compact && <h2>INBOX</h2>}
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
          {filteredItems.length > 0 && (
            <button
              className="inbox__bulk-dismiss"
              onClick={() => void bulkDismiss('1 day')}
              title="Snooze every visible item for 24 hours"
            >
              💤 Snooze all 24h
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
          <br />
          <br />
          <span className="inbox__hint inbox__hint--inline">
            Want more sources (Slack, Linear, calendar)? Drop a skill at{' '}
            <code>~/.jarvis/skills/&lt;name&gt;/SKILL.md</code> that writes{' '}
            <code>~/.jarvis/inbox/&lt;name&gt;.json</code> and add a routine.
            See <code>docs/scenarios.md</code> for the pattern.
          </span>
        </div>
      )}

      {items.length > 0 && filteredItems.length === 0 && (
        <div className="inbox__empty">
          {filterByScope && activeProject ? (
            <>
              Nothing tagged with <strong>{activeProject}</strong> right now.{' '}
              <br />
              {items.length} item{items.length === 1 ? '' : 's'} are showing in
              other scopes — click the filter chip to clear and see them.
            </>
          ) : (
            'Filter hides everything.'
          )}
        </div>
      )}

      {grouped.map(({ source, label, items: rows }) => (
        <section key={source} className="inbox__group">
          <h3 className="inbox__group-head">
            {label} <span className="inbox__group-count">{rows.length}</span>
          </h3>
          <ul className="inbox__list">
            {rows.map((item) => (
              <InboxRow
                key={item.id}
                item={item}
                binding={bindings.get(item.id)}
                onBind={(taskId) => bindings.bind(item.id, taskId)}
                onForget={() => bindings.clear(item.id)}
              />
            ))}
          </ul>
        </section>
      ))}
    </section>
  );
}

function InboxRow({
  item,
  binding,
  onBind,
  onForget,
}: {
  item: InboxItem;
  binding: TaskBindingState | undefined;
  onBind: (taskId: string) => void;
  onForget: () => void;
}) {
  const [acting, setActing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // "Starting soon" — fireAt within 10 min (matches the proximity
  // notification, ±some buffer for the eye). Re-evaluated on every
  // render which is fine; the Inbox view doesn't re-render every
  // second so this might be a few seconds stale.
  const startsSoon =
    item.fireAt != null && item.fireAt - Date.now() < 10 * 60 * 1000 && item.fireAt - Date.now() > 0;

  const act = async () => {
    if (!item.action) return;
    setActing(true);
    try {
      const summary = await window.jarvis.launchTask({
        prompt: item.action.prompt,
        skillId: item.action.skillId,
        origin: 'palette',
      });
      onBind(summary.id);
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

  const openBoundTask = () => {
    if (!binding) return;
    void window.jarvis.showAnswerHud(binding.taskId);
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

  // Clicking the title area opens the item's URL (if any) — matches
  // "click row to open" UX of most list views. The action buttons on
  // the right stay primary; this is just the intuitive shortcut.
  const titleClick = () => {
    if (item.url) {
      void window.jarvis.openExternal(item.url);
    }
  };

  return (
    <li className={`inbox__row${startsSoon ? ' inbox__row--soon' : ''}`}>
      <div
        className={`inbox__row-main${item.url ? ' inbox__row-main--clickable' : ''}`}
        onClick={item.url ? titleClick : undefined}
        title={item.url ? `Click to open ${item.url}` : undefined}
      >
        <div className="inbox__row-title">
          {startsSoon && <span className="inbox__row-pulse" aria-hidden />}
          {item.title}
        </div>
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
        {item.action && !binding && (
          <button
            className="inbox__row-primary"
            onClick={() => void act()}
            disabled={acting}
            title={item.action.skillId ? `Launches ${item.action.skillId}` : item.action.prompt}
          >
            {acting ? 'Launching…' : item.action.label}
          </button>
        )}
        {binding && (
          <TaskBindingBadge
            binding={binding}
            onOpen={openBoundTask}
            onRunAgain={() => {
              onForget();
              void act();
            }}
            onForget={onForget}
          />
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
