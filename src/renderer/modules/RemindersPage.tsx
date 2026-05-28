import { useEffect, useMemo, useState } from 'react';

import type { AppMode, Reminder } from '../../shared/types';
import { toast } from '../views/Toaster';

/**
 * Reminders pane. Two layers:
 *
 *   Primary (always visible):
 *     - Upcoming
 *     - Fired (awaiting done)
 *
 *   History (collapsed drawer):
 *     - Done · Cancelled
 *
 * Terminal states pile up forever, so keeping them folded under one
 * drawer with a "Clear history" affordance is what makes this scale.
 */
export function RemindersPage({ compact = false }: { compact?: boolean } = {}) {
  const [reminders, setReminders] = useState<Reminder[]>([]);
  // Autopilot mode skips the "Fire this reminder right now?" confirm —
  // user already signed up for less-friction by flipping the mode on.
  const [appMode, setAppMode] = useState<AppMode>('running');

  useEffect(() => {
    void window.jarvis.listReminders().then(setReminders);
    const off = window.jarvis.onRemindersChanged(setReminders);
    return off;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void window.jarvis.getAppMode().then((m) => {
      if (!cancelled) setAppMode(m);
    });
    const off = window.jarvis.onAppModeChanged((m) => setAppMode(m));
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  const groups = useMemo(() => groupByStatus(reminders), [reminders]);

  const cancel = async (id: string) => {
    try {
      await window.jarvis.cancelReminder(id);
      toast({ message: 'Reminder cancelled' });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const fireNow = async (id: string) => {
    if (appMode !== 'autopilot' && !confirm('Fire this reminder right now?')) {
      return;
    }
    try {
      await window.jarvis.fireReminderNow(id);
      toast({ message: 'Fired' });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const remove = async (id: string) => {
    if (!confirm('Remove this reminder from history?')) return;
    try {
      await window.jarvis.removeReminder(id);
      toast({ message: 'Removed' });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const removeSilently = async (id: string) => {
    try {
      await window.jarvis.removeReminder(id);
    } catch {
      // Swallow — bulk loop aggregates via toast at the end.
    }
  };

  const clearHistory = async () => {
    const ids = [...groups.done.map((r) => r.id), ...groups.cancelled.map((r) => r.id)];
    if (ids.length === 0) return;
    if (!confirm(`Remove all ${ids.length} reminder${ids.length === 1 ? '' : 's'} from history?\n\nThis can't be undone.`)) return;
    await Promise.all(ids.map((id) => removeSilently(id)));
    toast({ message: `Cleared ${ids.length} reminder${ids.length === 1 ? '' : 's'}` });
  };

  const markDone = async (id: string) => {
    try {
      await window.jarvis.markReminderDone(id);
      toast({ message: 'Marked done' });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const renderUpcomingActions = (r: Reminder) => (
    <>
      <button onClick={() => void fireNow(r.id)} title="Fire now">
        ▶ Fire now
      </button>
      <button
        onClick={() => void cancel(r.id)}
        className="reminders-page__btn--danger"
        title="Cancel and stop tracking"
      >
        ✕ Cancel
      </button>
    </>
  );

  const renderFiredActions = (r: Reminder) => (
    <>
      <button
        onClick={() => void markDone(r.id)}
        title="I did this — drop it from the inbox"
      >
        ✓ Done
      </button>
      {r.firedTaskId && (
        <button
          onClick={() => {
            window.dispatchEvent(
              new CustomEvent('jarvis:open-session', {
                detail: { taskId: r.firedTaskId },
              }),
            );
          }}
          title="Peek at the task that ran when this fired"
        >
          ↗ Peek
        </button>
      )}
      <button
        onClick={() => void remove(r.id)}
        className="reminders-page__btn--danger"
      >
        ✕ Remove
      </button>
    </>
  );

  const renderHistoryActions = (r: Reminder) => (
    <button
      onClick={() => void remove(r.id)}
      className="reminders-page__btn--danger"
    >
      ✕ Remove
    </button>
  );

  const primaryEmpty =
    groups.upcoming.length === 0 && groups.fired.length === 0;

  return (
    <section className={`reminders-page${compact ? ' reminders-page--compact' : ''}`}>
      {!compact && (
      <header className="reminders-page__header">
        <div>
          <h2>REMINDERS</h2>
          <p>
            Everything you've set via "remind me…" or "in 2h, …" — pending,
            fired, cancelled. Set new ones from the palette
            (<code>⌘⇧J</code>) or by typing them anywhere Jarvis takes
            free text.
          </p>
        </div>
        <div className="reminders-page__count">
          {reminders.length} total
        </div>
      </header>
      )}

      {primaryEmpty ? (
        <div className="reminders-page__empty reminders-page__empty--primary">
          Nothing to do. Set one from the palette: <code>remind me in 2h …</code>.
        </div>
      ) : (
        <>
          {groups.upcoming.length > 0 && (
            <ReminderGroup
              label="Upcoming"
              rows={groups.upcoming}
              renderActions={renderUpcomingActions}
            />
          )}
          {groups.fired.length > 0 && (
            <ReminderGroup
              label="Fired (awaiting done)"
              rows={groups.fired}
              renderActions={renderFiredActions}
            />
          )}
        </>
      )}

      <HistoryDrawer
        done={groups.done}
        cancelled={groups.cancelled}
        onClear={() => void clearHistory()}
        renderActions={renderHistoryActions}
      />
    </section>
  );
}

function ReminderGroup({
  label,
  rows,
  renderActions,
}: {
  label: string;
  rows: Reminder[];
  renderActions: (r: Reminder) => React.ReactNode;
}) {
  return (
    <section className="reminders-page__group">
      <h3 className="reminders-page__group-label">
        {label} <span className="reminders-page__group-count">{rows.length}</span>
      </h3>
      <ReminderList rows={rows} renderActions={renderActions} />
    </section>
  );
}

function ReminderList({
  rows,
  renderActions,
}: {
  rows: Reminder[];
  renderActions: (r: Reminder) => React.ReactNode;
}) {
  return (
    <ul className="reminders-page__list">
      {rows.map((r) => (
        <ReminderRow key={r.id} reminder={r} renderActions={renderActions} />
      ))}
    </ul>
  );
}

function ReminderRow({
  reminder: r,
  renderActions,
}: {
  reminder: Reminder;
  renderActions: (r: Reminder) => React.ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  // Only the body itself is clickable to expand — the action buttons
  // on the right shouldn't toggle the row state.
  const toggle = () => setExpanded((v) => !v);
  return (
    <li
      className={`reminders-page__row${expanded ? ' reminders-page__row--expanded' : ''}`}
    >
      <span
        className={`reminders-page__mode reminders-page__mode--${r.mode}`}
        title={
          r.mode === 'reminder'
            ? 'Fires a notification only — no agent run.'
            : 'Spawns a Claude task to carry it out.'
        }
      >
        {r.mode === 'reminder' ? 'nudge' : 'action'}
      </span>
      {r.cron && (
        <span
          className="reminders-page__mode reminders-page__mode--recurring"
          title={`Recurring · ${r.cron}`}
        >
          🔁 {humanizeCron(r.cron)}
        </span>
      )}
      <button
        type="button"
        className="reminders-page__body"
        onClick={toggle}
        title={expanded ? 'Collapse' : 'Click to expand · ' + r.body}
        aria-expanded={expanded}
      >
        <div className="reminders-page__body-text">{r.body}</div>
        <div className="reminders-page__body-meta">{formatWhen(r)}</div>
      </button>
      <div className="reminders-page__actions">{renderActions(r)}</div>
    </li>
  );
}

function HistoryDrawer({
  done,
  cancelled,
  onClear,
  renderActions,
}: {
  done: Reminder[];
  cancelled: Reminder[];
  onClear: () => void;
  renderActions: (r: Reminder) => React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const total = done.length + cancelled.length;

  return (
    <section className="column-drawer">
      <div className="column-drawer__head-row">
        <button
          className="column-drawer__head"
          onClick={() => setOpen((v) => !v)}
          title={open ? 'Collapse history' : 'Expand history'}
        >
          <span className="column-drawer__caret">{open ? '▾' : '▸'}</span>
          <span className="column-drawer__label">History</span>
          <span className="column-drawer__count">{total}</span>
          {open && total > 0 && (
            <span className="column-drawer__breakdown">
              Done {done.length} · Cancelled {cancelled.length}
            </span>
          )}
        </button>
        {open && total > 0 && (
          <button
            className="column-drawer__bulk-clear"
            onClick={(e) => {
              e.stopPropagation();
              onClear();
            }}
            title="Permanently remove all done + cancelled reminders"
          >
            Clear history
          </button>
        )}
      </div>
      {open && (
        total === 0 ? (
          <div className="column-drawer__empty">
            Reminders you mark done or cancel land here.
          </div>
        ) : (
          <div className="column-drawer__body">
            {done.length > 0 && (
              <div className="column-drawer__subgroup">
                <h4 className="column-drawer__subgroup-label">
                  Done <span className="column-drawer__subgroup-count">{done.length}</span>
                </h4>
                <ReminderList rows={done} renderActions={renderActions} />
              </div>
            )}
            {cancelled.length > 0 && (
              <div className="column-drawer__subgroup">
                <h4 className="column-drawer__subgroup-label">
                  Cancelled <span className="column-drawer__subgroup-count">{cancelled.length}</span>
                </h4>
                <ReminderList rows={cancelled} renderActions={renderActions} />
              </div>
            )}
          </div>
        )
      )}
    </section>
  );
}

function groupByStatus(reminders: Reminder[]): {
  upcoming: Reminder[];
  fired: Reminder[];
  done: Reminder[];
  cancelled: Reminder[];
} {
  const upcoming: Reminder[] = [];
  const fired: Reminder[] = [];
  const done: Reminder[] = [];
  const cancelled: Reminder[] = [];
  for (const r of reminders) {
    if (r.status === 'fired') fired.push(r);
    else if (r.status === 'done') done.push(r);
    else if (r.status === 'cancelled') cancelled.push(r);
    else upcoming.push(r);
  }
  upcoming.sort((a, b) => a.fireAt - b.fireAt);
  fired.sort((a, b) => (b.firedAt ?? b.fireAt) - (a.firedAt ?? a.fireAt));
  done.sort((a, b) => (b.doneAt ?? b.firedAt ?? b.fireAt) - (a.doneAt ?? a.firedAt ?? a.fireAt));
  cancelled.sort((a, b) => b.createdAt - a.createdAt);
  return { upcoming, fired, done, cancelled };
}

function formatWhen(r: Reminder): string {
  const abs = new Date(r.fireAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  if (r.status === 'pending') {
    return `${formatRel(r.fireAt)} · ${abs}`;
  }
  if (r.status === 'fired' && r.firedAt) {
    return `fired ${formatRel(r.firedAt)} · was ${abs}`;
  }
  return abs;
}

function formatRel(ms: number): string {
  const diff = ms - Date.now();
  const abs = Math.abs(diff);
  const past = diff < 0;
  if (abs < 60_000) return past ? 'just now' : 'right now';
  const m = Math.round(abs / 60_000);
  if (m < 60) return past ? `${m}m ago` : `in ${m}m`;
  const h = Math.round(m / 60);
  if (h < 24) return past ? `${h}h ago` : `in ${h}h`;
  const d = Math.round(h / 24);
  return past ? `${d}d ago` : `in ${d}d`;
}

const DOW_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function humanizeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return cron;
  const [minute, hour, dom, mon, dow] = parts as [string, string, string, string, string];
  if (dom !== '*' || mon !== '*') return cron;
  const time = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
  if (dow === '*') return `daily at ${time}`;
  if (dow === '1-5') return `weekdays at ${time}`;
  if (dow === '0,6' || dow === '6,0') return `weekends at ${time}`;
  const days = dow
    .split(',')
    .map((d) => parseInt(d, 10))
    .filter((d) => d >= 0 && d <= 6)
    .map((d) => DOW_NAMES[d])
    .join(', ');
  if (!days) return cron;
  return `${days} at ${time}`;
}
