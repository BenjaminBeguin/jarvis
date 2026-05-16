import { useEffect, useMemo, useState } from 'react';

import type {
  InboxItem,
  InboxPrefs,
  MeetingDetectionStatus,
  TaskSummary,
} from '../../shared/types';
import { DEFAULT_INBOX_PREFS } from '../../shared/types';
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
  const [dismissed, setDismissed] = useState<InboxItem[]>([]);
  const [showDismissed, setShowDismissed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<string | null>(() =>
    readActiveProject(),
  );
  // Default ON when a project scope is active. Toggle off to see everything.
  const [filterByScope, setFilterByScope] = useState<boolean>(() =>
    readActiveProject() !== null,
  );
  const [inboxPrefs, setInboxPrefs] = useState<InboxPrefs>(DEFAULT_INBOX_PREFS);
  // Live-strip state — populated only when the corresponding strip is
  // shown. The data sources (tasks for awaiting; detection watcher
  // for meeting) are global so the cost is the same whether the
  // strips are visible or not, but skipping the IPC + subscription
  // when hidden keeps the renderer cheap.
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [meetingStatus, setMeetingStatus] = useState<MeetingDetectionStatus | null>(
    null,
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
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
    void window.jarvis.listInboxDismissed().then(setDismissed);
    // 2. Then kick a fresh refresh in the background.
    void doRefresh();
    const offChanged = window.jarvis.onInboxChanged((next) => {
      setItems(next);
      setLastRefreshedAt(Date.now());
      // Dismissed list piggybacks on the same trigger — anytime the
      // active set changes (refresh, dismiss, restore) we re-pull it.
      void window.jarvis.listInboxDismissed().then(setDismissed);
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

  // Re-engage the filter when scope is set; clear when removed.
  // Tracks scope changes so flipping projects in the picker carries
  // through to the Inbox automatically.
  useEffect(() => {
    setFilterByScope(activeProject !== null);
  }, [activeProject]);

  // Live inbox prefs — per-source toggles from Settings → Inbox. Read
  // once on mount + subscribe to changes so the filter updates without
  // a reload.
  useEffect(() => {
    let cancelled = false;
    void window.jarvis.readInboxPrefs().then((p) => {
      if (!cancelled) setInboxPrefs(p);
    });
    const off = window.jarvis.onInboxPrefsChanged(setInboxPrefs);
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Live strips — task list + meeting detection. Compact mode skips
  // these (the dashboard widget version already has the dashboard
  // context around it; redoing them inside would be noise).
  useEffect(() => {
    if (compact) return;
    void window.jarvis.listTasks().then(setTasks);
    void window.jarvis.meetingDetectionStatus().then(setMeetingStatus);
    const offTaskStatus = window.jarvis.onTaskStatus((summary) => {
      setTasks((prev) => {
        const i = prev.findIndex((t) => t.id === summary.id);
        if (i === -1) return [summary, ...prev];
        const next = prev.slice();
        next[i] = summary;
        return next;
      });
    });
    const offTaskRemoved = window.jarvis.onTaskRemoved((id) =>
      setTasks((prev) => prev.filter((t) => t.id !== id)),
    );
    const offDetection = window.jarvis.onMeetingDetectionChanged(setMeetingStatus);
    // Tick every 30s so the meeting strip's "auto-detect: live/quiet"
    // label re-evaluates as silence stretches past the threshold.
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      offTaskStatus();
      offTaskRemoved();
      offDetection();
      window.clearInterval(tick);
    };
  }, [compact]);

  // Awaiting-input tasks — the band that was on Now.
  const awaitingTasks = useMemo(
    () =>
      tasks.filter(
        (t) =>
          t.awaitingInput &&
          t.status === 'running' &&
          t.origin !== 'external' &&
          // Honor the scope filter the rest of Inbox respects.
          (!filterByScope ||
            !activeProject ||
            !t.projectName ||
            t.projectName === activeProject),
      ),
    [tasks, filterByScope, activeProject],
  );

  // Soft refresh — re-reads every InboxSource. Cheap; used on mount
  // and by the background 5-min auto-refresh. For user-authored
  // sources backed by a JSON file, this only catches whatever's
  // already on disk; the skill that produced it doesn't re-run.
  const doRefresh = async () => {
    setError(null);
    try {
      await window.jarvis.refreshInbox();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  // Hard refresh — what the button does when you actually click it.
  // Re-fires every `*-inbox` routine, waits for the spawned tasks to
  // land, then re-reads all sources. Slower (typically 5-30s), but
  // genuinely rescrapes user-authored sources instead of pretending
  // to refresh by re-reading stale JSON.
  const doHardRefresh = async () => {
    setError(null);
    try {
      await window.jarvis.hardRefreshInbox();
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
    // 1. Drop items whose source is disabled in Settings → Inbox.
    const disabledSet = new Set(inboxPrefs.disabledSources);
    let next = items.filter((it) => !disabledSet.has(it.source));

    // 2. For sources still enabled: calendar items outside the
    //    configured window are dropped from the Inbox. Default 24h —
    //    user can tune in Settings → Inbox. The Calendar tab and
    //    Dashboard Calendar timeline read the same JSON file through
    //    other paths and still see the full 7-day window.
    if (!disabledSet.has('calendar')) {
      const windowMs = inboxPrefs.calendarWindowHours * 60 * 60 * 1000;
      const cutoff = Date.now() + windowMs;
      next = next.filter((it) => {
        if (it.source !== 'calendar') return true;
        if (it.fireAt == null) return true;
        return it.fireAt <= cutoff;
      });
    }

    // 3. Project scope: items matching the active project AND items
    //    with no project tag (calendar events, generic reminders, …)
    //    stay; items belonging to OTHER projects are hidden.
    if (!filterByScope || !activeProject) return next;
    return next.filter((it) => !it.project || it.project === activeProject);
  }, [items, filterByScope, activeProject, inboxPrefs]);

  const grouped = useMemo(() => groupBySource(filteredItems), [filteredItems]);
  const hiddenCount = items.length - filteredItems.length;

  return (
    <section className={`inbox${compact ? ' inbox--compact' : ''}`}>
      <header className="inbox__head">
        <div>
          {!compact && <h2>INBOX</h2>}
          <div className="inbox__hint">
            {items.length === 0 && !refreshing
              ? 'Nothing waiting on you.'
              : (() => {
                  const scopedNote =
                    filterByScope && activeProject
                      ? ` · scoped to ${activeProject}`
                      : '';
                  // "N of M items" anytime any filter is hiding rows
                  // (disabled source, calendar window, project scope).
                  const countNote =
                    hiddenCount > 0
                      ? `${filteredItems.length} of ${items.length} item${items.length === 1 ? '' : 's'}`
                      : `${items.length} item${items.length === 1 ? '' : 's'}`;
                  const refreshedNote = lastRefreshedAt
                    ? ` · refreshed ${formatRelative(lastRefreshedAt)}`
                    : '';
                  return `${countNote}${scopedNote}${refreshedNote}`;
                })()}
          </div>
        </div>
        <div className="inbox__head-actions">
          {activeProject && (
            <button
              className={`inbox__scope-filter${filterByScope ? ' inbox__scope-filter--on' : ''}`}
              onClick={() => setFilterByScope((v) => !v)}
              title={
                filterByScope
                  ? `Showing ${activeProject} items + ambient (no-project) items. Click to show ALL projects.`
                  : `Currently showing ALL projects. Click to filter to ${activeProject} + ambient items.`
              }
            >
              {filterByScope
                ? `✓ Scoped to ${activeProject}`
                : `Show all · currently ${activeProject}`}
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
            onClick={() => void doHardRefresh()}
            disabled={refreshing}
            title="Re-fire every inbox source skill, then re-read · ⌥-click for a soft re-read"
            onAuxClick={(e) => {
              // Middle-click → soft refresh (re-read disk only). Hidden
              // power-user escape hatch for when you don't want to
              // re-run skills.
              if (e.button === 1) {
                e.preventDefault();
                void doRefresh();
              }
            }}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          {!compact && (
            <button
              className="inbox__settings"
              onClick={() => setSettingsOpen((v) => !v)}
              title="Inbox strip toggles + preferences"
              aria-label="Inbox settings"
            >
              ⚙
            </button>
          )}
        </div>
      </header>

      {!compact && settingsOpen && (
        <InboxSettingsPopover
          prefs={inboxPrefs}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {!compact && (inboxPrefs.showMeetingStrip ?? true) && (
        <MeetingStrip status={meetingStatus} now={now} />
      )}
      {!compact && (inboxPrefs.showAwaitingStrip ?? true) && awaitingTasks.length > 0 && (
        <AwaitingStrip tasks={awaitingTasks} />
      )}
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

      <DismissedSection
        rows={dismissed}
        open={showDismissed}
        onToggle={() => setShowDismissed((v) => !v)}
      />
    </section>
  );
}

/**
 * Collapsible "Dismissed" section — every inbox item the user has
 * currently snoozed/dismissed. Same shape as Notes' Done/Archived:
 * a header with caret + count, body lists each row with a Restore
 * action that un-snoozes it.
 *
 * Only shows items still in the in-memory store. PRs that have aged
 * out entirely (reviewed, branch merged) aren't tracked here — those
 * just vanish on the next refresh.
 */
function DismissedSection({
  rows,
  open,
  onToggle,
}: {
  rows: InboxItem[];
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <section className="inbox-dismissed">
      <button
        className="inbox-dismissed__head"
        onClick={onToggle}
        title={open ? 'Collapse dismissed' : 'Expand dismissed'}
      >
        <span className="inbox-dismissed__caret">{open ? '▾' : '▸'}</span>
        <span className="inbox-dismissed__label">Dismissed</span>
        <span className="inbox-dismissed__count">{rows.length}</span>
      </button>
      {open &&
        (rows.length === 0 ? (
          <div className="inbox-dismissed__empty">
            Nothing dismissed right now. Click <code>×</code> on a row
            and pick a snooze duration to send it here.
          </div>
        ) : (
          <ul className="inbox-dismissed__list">
            {rows.map((item) => (
              <DismissedRow key={item.id} item={item} />
            ))}
          </ul>
        ))}
    </section>
  );
}

function DismissedRow({ item }: { item: InboxItem }) {
  const restore = async () => {
    try {
      await window.jarvis.restoreInboxItem(item.id);
      toast({ message: 'Restored' });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <li className="inbox-dismissed__row">
      <div className="inbox-dismissed__main">
        <div className="inbox-dismissed__title">{item.title}</div>
        {item.subtitle && (
          <div className="inbox-dismissed__sub">{item.subtitle}</div>
        )}
      </div>
      <button
        className="inbox-dismissed__restore"
        onClick={() => void restore()}
        title="Bring this back to the active inbox"
      >
        ↺ Restore
      </button>
    </li>
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
    // open-url actions are pure navigation — opening a link doesn't
    // need a Claude turn. Skip the runner entirely so the button feels
    // like a link, not a "loading…" affordance.
    if (item.action.kind === 'open-url') {
      const target = item.action.url ?? item.url;
      if (target) void window.jarvis.openExternal(target);
      return;
    }
    // task action (default) — actually spawn an agent.
    const prompt = item.action.prompt ?? '';
    if (!prompt.trim()) {
      toast({ kind: 'error', message: 'Action has no prompt to launch.' });
      return;
    }
    setActing(true);
    try {
      const summary = await window.jarvis.launchTask({
        prompt,
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

  // Clicking the row routes to whatever surface owns this item — URL
  // for PR / calendar rows, the Reminders page for reminders, Routines
  // for failed routines, etc. Action buttons on the right stay primary;
  // this is the intuitive secondary shortcut. Every row gets a
  // destination so the click affordance is consistent across sources.
  const rowDestination = ((): { title: string; run: () => void } | null => {
    if (item.url) {
      return {
        title: `Click to open ${item.url}`,
        run: () => void window.jarvis.openExternal(item.url!),
      };
    }
    if (item.source === 'reminders') {
      return {
        title: 'Click to open the Reminders page',
        run: () =>
          window.dispatchEvent(
            new CustomEvent('jarvis:navigate', {
              detail: { tab: 'settings', moduleId: 'reminders' },
            }),
          ),
      };
    }
    if (item.source === 'failed-routines') {
      return {
        title: 'Click to open the Routines tab',
        run: () =>
          window.dispatchEvent(
            new CustomEvent('jarvis:navigate', { detail: { tab: 'routines' } }),
          ),
      };
    }
    if (item.source === 'calendar') {
      // Calendar items without a meeting URL — open the Calendar page.
      return {
        title: 'Click to open the Calendar',
        run: () =>
          window.dispatchEvent(
            new CustomEvent('jarvis:navigate', {
              detail: { tab: 'settings', moduleId: 'calendar' },
            }),
          ),
      };
    }
    if (item.source === 'dedupe') {
      // Dedupe suggestions — open the merged Notes & Reminders page
      // so the user can review the duplicate side-by-side. No
      // auto-merge; this is manual review by design.
      return {
        title: 'Click to review the duplicate captures',
        run: () =>
          window.dispatchEvent(
            new CustomEvent('jarvis:navigate', {
              detail: { tab: 'settings', moduleId: 'quick-note' },
            }),
          ),
      };
    }
    return null;
  })();

  return (
    <li className={`inbox__row${startsSoon ? ' inbox__row--soon' : ''}`}>
      <div
        className={`inbox__row-main${rowDestination ? ' inbox__row-main--clickable' : ''}`}
        onClick={rowDestination ? rowDestination.run : undefined}
        title={rowDestination?.title}
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
        {item.url && !(item.action?.kind === 'open-url') && (
          // Skip the generic "Open" button when the action itself is
          // already an open-url with a custom label (e.g. "Open in
          // Linear") — two buttons that do the same thing reads as
          // a UI bug.
          <button className="inbox__row-link" onClick={open} title={item.url}>
            Open
          </button>
        )}
        {item.source === 'reminders' && !item.subtitle?.includes('🔁') && (
          // Hidden for recurring reminders (subtitle carries the
          // 🔁 marker from remindersInboxSource): "Mark done" there
          // would cancel the whole series instead of just this
          // occurrence, which is rarely what the user wants. To end
          // a recurring series, go to the Reminders page → Cancel.
          <button
            className="inbox__row-done"
            onClick={async () => {
              // Item id is `reminder-<reminderId>` (see remindersInboxSource).
              const reminderId = item.id.replace(/^reminder-/, '');
              try {
                await window.jarvis.markReminderDone(reminderId);
              } catch (e) {
                toast({
                  kind: 'error',
                  message: e instanceof Error ? e.message : String(e),
                });
              }
            }}
            title="I did this — drop it from the inbox (keeps history in the Reminders page)"
          >
            ✓ Done
          </button>
        )}
        {item.action && !binding && (
          <button
            className={`inbox__row-primary${item.action.kind === 'open-url' ? ' inbox__row-primary--link' : ''}`}
            onClick={() => void act()}
            disabled={acting && item.action.kind !== 'open-url'}
            title={
              item.action.kind === 'open-url'
                ? `Opens ${item.action.url ?? item.url ?? 'a link'}`
                : item.action.skillId
                ? `Launches ${item.action.skillId}`
                : item.action.prompt ?? item.action.label
            }
          >
            {item.action.kind !== 'open-url' && acting
              ? 'Launching…'
              : item.action.label}
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

/** Stable section order. Reminders first (user-scheduled, time-
 *  pressured), then broken routines (something the user wired up
 *  is failing — actionable), then "blocked on you" surfaces (PR
 *  comments before PR reviews because those are *your* code waiting),
 *  then work-tracker / chat / ambient. Unknown sources fall through
 *  to the bottom with their raw source name as label. */
const SOURCE_ORDER: Record<string, { rank: number; label: string }> = {
  reminders: { rank: 0, label: 'Scheduled' },
  'failed-routines': { rank: 1, label: 'Needs attention' },
  'pr-comments': { rank: 2, label: 'Comments on your PRs' },
  'pr-review': { rank: 3, label: 'PRs awaiting your review' },
  linear: { rank: 4, label: 'Linear · needs you' },
  slack: { rank: 5, label: 'Slack · waiting on you' },
  calendar: { rank: 6, label: 'Calendar' },
  'meeting-activity': { rank: 7, label: 'Mic active' },
  dedupe: { rank: 8, label: 'Possible duplicates' },
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

// ── Live strips (merged in from the retired Now tab) ────────────────

/**
 * Meeting strip — manual `Record now` button + an honest detection
 * pill. macOS 15 (Sequoia) silences the coreaudiod log channel that
 * the watcher parses, so the pill goes yellow ("quiet") when no
 * events have arrived since startup. The record button works
 * regardless of detection state.
 */
function MeetingStrip({
  status,
  now,
}: {
  status: MeetingDetectionStatus | null;
  now: number;
}) {
  const [busy, setBusy] = useState(false);
  const detectState: 'live' | 'quiet' | 'fault' | 'off' = (() => {
    if (!status) return 'off';
    if (status.fault) return 'fault';
    if (!status.running) return 'off';
    if (status.inputEventsSeen > 0) {
      if (status.lastInputAt && now - status.lastInputAt < 5 * 60_000) {
        return 'live';
      }
      return 'quiet';
    }
    return now - status.startedAt > 60_000 ? 'quiet' : 'live';
  })();
  const pillText =
    detectState === 'live'
      ? 'auto-detect: live'
      : detectState === 'quiet'
      ? 'auto-detect: quiet'
      : detectState === 'fault'
      ? 'auto-detect: fault'
      : 'auto-detect: off';
  const pillTitle =
    detectState === 'fault'
      ? status?.fault ?? 'Watcher errored.'
      : detectState === 'quiet'
      ? 'macOS 15 quiets the audio log channel — auto-detect is best-effort. Use the button for ad-hoc calls.'
      : detectState === 'live'
      ? `Saw ${status?.inputEventsSeen ?? 0} mic event(s) since start.`
      : 'Watcher not started yet.';

  const record = async () => {
    setBusy(true);
    try {
      const result = await window.jarvis.dispatchIntent(
        'meeting-recorder',
        'start',
        '',
      );
      if (result.ok) {
        toast({ message: result.message ?? 'Recording started' });
      } else {
        toast({ kind: 'error', message: result.message ?? 'Failed to start' });
      }
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="inbox__strip inbox__strip--meeting">
      <button
        className="inbox__strip-record"
        onClick={record}
        disabled={busy}
        title="Start recording the current meeting (Whisper, local)"
      >
        🎙 {busy ? 'Starting…' : 'Record meeting'}
      </button>
      <span
        className={`inbox__strip-detect inbox__strip-detect--${detectState}`}
        title={pillTitle}
      >
        {pillText}
      </span>
    </div>
  );
}

/**
 * Awaiting-input strip — tasks blocked on the user's reply. Clicking
 * a row jumps to the Observatory and focuses that task.
 */
function AwaitingStrip({ tasks }: { tasks: TaskSummary[] }) {
  // Peek into the session sidebar — keeps the user on the Inbox tab
  // instead of jumping to Observatory. The sidebar has the inline
  // reply box wired so they can answer the prompt from here.
  const peek = (id: string): void => {
    window.dispatchEvent(
      new CustomEvent('jarvis:open-session', { detail: { taskId: id } }),
    );
  };
  return (
    <div className="inbox__strip inbox__strip--awaiting">
      <span className="inbox__strip-dot" aria-hidden />
      <span className="inbox__strip-label">
        {tasks.length} awaiting your reply
      </span>
      <ul className="inbox__strip-tasks">
        {tasks.slice(0, 4).map((t) => (
          <li key={t.id}>
            <button
              className="inbox__strip-task"
              onClick={() => peek(t.id)}
              title={t.title}
            >
              {t.title.length > 60 ? `${t.title.slice(0, 60)}…` : t.title}
            </button>
          </li>
        ))}
        {tasks.length > 4 && (
          <li className="inbox__strip-task inbox__strip-task--more">
            + {tasks.length - 4} more
          </li>
        )}
      </ul>
    </div>
  );
}

/**
 * Settings popover for the strips. Two checkboxes today; room to
 * grow without inventing a new surface. Writes the flip to the
 * InboxPrefs IPC immediately so a toggle takes effect without an
 * explicit save.
 */
function InboxSettingsPopover({
  prefs,
  onClose,
}: {
  prefs: InboxPrefs;
  onClose: () => void;
}) {
  const update = async (patch: Partial<InboxPrefs>) => {
    const next: InboxPrefs = { ...prefs, ...patch };
    try {
      await window.jarvis.writeInboxPrefs(next);
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };
  return (
    <div className="inbox__settings-popover" role="dialog" aria-label="Inbox settings">
      <header>
        <strong>Strips</strong>
        <button onClick={onClose} aria-label="Close" title="Close (Esc)">
          ✕
        </button>
      </header>
      <label>
        <input
          type="checkbox"
          checked={prefs.showMeetingStrip ?? true}
          onChange={(e) => void update({ showMeetingStrip: e.target.checked })}
        />
        <div>
          <strong>Meeting strip</strong>
          <span>Manual record button + auto-detect status.</span>
        </div>
      </label>
      <label>
        <input
          type="checkbox"
          checked={prefs.showAwaitingStrip ?? true}
          onChange={(e) => void update({ showAwaitingStrip: e.target.checked })}
        />
        <div>
          <strong>Awaiting reply</strong>
          <span>Tasks blocked on your input (hidden when empty).</span>
        </div>
      </label>
      <p className="inbox__settings-hint">
        Wider Inbox prefs (per-source toggles, calendar window) live in
        Settings → Inbox.
      </p>
    </div>
  );
}
