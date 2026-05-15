import { useEffect, useMemo, useState } from 'react';

import type { Reminder } from '../../shared/types';
import { toast } from '../views/Toaster';

/**
 * Single-pane view of every reminder + scheduled action the user has set.
 * Three buckets — Upcoming · Fired · Cancelled — newest first within each.
 * Each row has the body, the fire time (relative + absolute), and the
 * status-appropriate action set:
 *
 *   Upcoming: [ ▶ Fire now ] [ ✕ Cancel ]
 *   Fired:    [ ✕ Remove ]   (and a link to the task if scheduled mode
 *                              spawned one)
 *   Cancelled: [ ✕ Remove ]
 *
 * Powered by the existing reminders IPC — no new plumbing.
 */
export function RemindersPage() {
  const [reminders, setReminders] = useState<Reminder[]>([]);

  useEffect(() => {
    void window.jarvis.listReminders().then(setReminders);
    const off = window.jarvis.onRemindersChanged(setReminders);
    return off;
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
    if (!confirm('Fire this reminder right now?')) return;
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

  return (
    <section className="reminders-page">
      <header className="reminders-page__header">
        <div>
          <h2>REMINDERS</h2>
          <p>
            Everything you've set via "remind me…" or "in 2h, …" — pending,
            fired, cancelled. Set new ones from the palette
            (<code>⌘⇧J</code>) or by typing them anywhere Jarvis takes
            free text · for free-form jottings use{' '}
            <button
              className="module-page__crosslink"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent('jarvis:navigate', {
                    detail: { tab: 'settings', moduleId: 'quick-note' },
                  }),
                )
              }
              title="Open the Notes page"
            >
              Notes ↗
            </button>
          </p>
        </div>
        <div className="reminders-page__count">
          {reminders.length} {reminders.length === 1 ? 'total' : 'total'}
        </div>
      </header>

      <ReminderGroup
        label="Upcoming"
        rows={groups.upcoming}
        emptyHint="No reminders pending."
        renderActions={(r) => (
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
        )}
      />

      <ReminderGroup
        label="Fired (awaiting done)"
        rows={groups.fired}
        emptyHint="Nothing fired and unhandled."
        renderActions={(r) => (
          <>
            <button
              onClick={async () => {
                try {
                  await window.jarvis.markReminderDone(r.id);
                  toast({ message: 'Marked done' });
                } catch (e) {
                  toast({
                    kind: 'error',
                    message: e instanceof Error ? e.message : String(e),
                  });
                }
              }}
              title="I did this — drop it from the inbox"
            >
              ✓ Done
            </button>
            {r.firedTaskId && (
              <button
                onClick={() => {
                  window.dispatchEvent(
                    new CustomEvent('jarvis:navigate', {
                      detail: { tab: 'observatory' },
                    }),
                  );
                  window.dispatchEvent(
                    new CustomEvent('jarvis:focus-task', {
                      detail: { taskId: r.firedTaskId },
                    }),
                  );
                }}
                title="Open the task that ran when this fired"
              >
                ↗ Open task
              </button>
            )}
            <button
              onClick={() => void remove(r.id)}
              className="reminders-page__btn--danger"
            >
              ✕ Remove
            </button>
          </>
        )}
      />

      <ReminderGroup
        label="Done"
        rows={groups.done}
        emptyHint="No reminders marked done yet."
        renderActions={(r) => (
          <button
            onClick={() => void remove(r.id)}
            className="reminders-page__btn--danger"
          >
            ✕ Remove
          </button>
        )}
      />

      <ReminderGroup
        label="Cancelled"
        rows={groups.cancelled}
        emptyHint="No cancelled reminders."
        renderActions={(r) => (
          <button
            onClick={() => void remove(r.id)}
            className="reminders-page__btn--danger"
          >
            ✕ Remove
          </button>
        )}
      />
    </section>
  );
}

function ReminderGroup({
  label,
  rows,
  emptyHint,
  renderActions,
}: {
  label: string;
  rows: Reminder[];
  emptyHint: string;
  renderActions: (r: Reminder) => React.ReactNode;
}) {
  return (
    <section className="reminders-page__group">
      <h3 className="reminders-page__group-label">
        {label} <span className="reminders-page__group-count">{rows.length}</span>
      </h3>
      {rows.length === 0 ? (
        <div className="reminders-page__empty">{emptyHint}</div>
      ) : (
        <ul className="reminders-page__list">
          {rows.map((r) => (
            <li key={r.id} className="reminders-page__row">
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
              <div className="reminders-page__body">
                <div className="reminders-page__body-text">{r.body}</div>
                <div className="reminders-page__body-meta">
                  {formatWhen(r)}
                </div>
              </div>
              <div className="reminders-page__actions">{renderActions(r)}</div>
            </li>
          ))}
        </ul>
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
