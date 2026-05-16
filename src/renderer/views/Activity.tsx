import { useEffect, useMemo, useState } from 'react';

import type { ActivityEvent, TaskSummary } from '../../shared/types';

/**
 * Activity tab — Phase 2.
 *
 * Two data streams merged into one time-sorted feed:
 *   1. `/send` tasks (filtered from TaskRegistry; same as Phase 1 — the
 *      conversational rows with channel chip + status badge).
 *   2. ActivityStore events (note created, meeting started, MCP
 *      disabled, inbox source cleared, etc.).
 *
 * Click a /send row → opens its transcript in the Observatory. Click
 * an event row → does whatever the `kind` warrants (open file, jump
 * to a tab) via small per-kind handlers below. Phase 3 would add a
 * filter bar across the top; for now everything is one stream.
 */

type Row =
  | { kind: 'send'; ts: number; task: TaskSummary }
  | { kind: 'event'; ts: number; event: ActivityEvent };

/** Filter chip selections — null means "show everything." */
type CategoryFilter =
  | null
  | 'send'
  | 'note'
  | 'meeting'
  | 'integration'
  | 'inbox'
  | 'reminder'
  | 'dedupe';

const FILTER_KEY = 'jarvis.activity.filter';

export function Activity() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [filter, setFilterRaw] = useState<CategoryFilter>(() => {
    try {
      const stored = window.localStorage.getItem(FILTER_KEY);
      if (stored === null) return null;
      const valid: CategoryFilter[] = [
        'send', 'note', 'meeting', 'integration', 'inbox', 'reminder', 'dedupe',
      ];
      return (valid as string[]).includes(stored) ? (stored as CategoryFilter) : null;
    } catch {
      return null;
    }
  });
  const setFilter = (f: CategoryFilter) => {
    setFilterRaw(f);
    try {
      if (f === null) window.localStorage.removeItem(FILTER_KEY);
      else window.localStorage.setItem(FILTER_KEY, f);
    } catch {
      // private mode etc — non-fatal
    }
  };

  useEffect(() => {
    void window.jarvis.listTasks().then(setTasks);
    const offStatus = window.jarvis.onTaskStatus((summary) => {
      setTasks((prev) => {
        const i = prev.findIndex((t) => t.id === summary.id);
        if (i === -1) return [summary, ...prev];
        const next = prev.slice();
        next[i] = summary;
        return next;
      });
    });
    const offRemoved = window.jarvis.onTaskRemoved((taskId) => {
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
    });
    return () => {
      offStatus();
      offRemoved();
    };
  }, []);

  useEffect(() => {
    void window.jarvis.listActivity(200).then(setEvents);
    const off = window.jarvis.onActivityChanged((event) => {
      setEvents((prev) => [event, ...prev]);
    });
    return off;
  }, []);

  const rows = useMemo<Row[]>(() => {
    const sendRows: Row[] = tasks
      .filter((t) => t.skillId === 'send')
      .map((t) => ({ kind: 'send', ts: t.startedAt, task: t }));
    const eventRows: Row[] = events.map((e) => ({
      kind: 'event',
      ts: e.ts,
      event: e,
    }));
    let merged = [...sendRows, ...eventRows].sort((a, b) => b.ts - a.ts);
    if (filter !== null) {
      merged = merged.filter((r) => {
        if (r.kind === 'send') return filter === 'send';
        const meta = EVENT_KIND_META[r.event.kind];
        return meta?.category === filter;
      });
    }
    return merged.slice(0, 200);
  }, [tasks, events, filter]);

  // Counts per category — surfaces in the chip labels so the user
  // sees "Reminders 3" instead of just "Reminders." Helps decide what
  // to filter to.
  const counts = useMemo(() => {
    const out: Record<string, number> = {
      send: 0,
      note: 0,
      meeting: 0,
      integration: 0,
      inbox: 0,
      reminder: 0,
      dedupe: 0,
    };
    for (const t of tasks) if (t.skillId === 'send') out.send!++;
    for (const e of events) {
      const cat = EVENT_KIND_META[e.kind]?.category;
      if (cat && cat !== 'other') out[cat] = (out[cat] ?? 0) + 1;
    }
    return out;
  }, [tasks, events]);

  return (
    <section className="activity">
      <header className="activity__header">
        <div>
          <h2>ACTIVITY</h2>
          <p>
            Things you've done through Jarvis — <code>/send</code> messages,
            meetings, notes, integration toggles, inbox cleanups. Click a
            row to jump to its surface.
          </p>
        </div>
        <div className="activity__count">
          {rows.length} {rows.length === 1 ? 'row' : 'rows'}
        </div>
      </header>

      <CategoryFilterStrip
        active={filter}
        counts={counts}
        onChange={setFilter}
      />

      {rows.length === 0 ? (
        <div className="activity__empty">
          Nothing here yet. As you use Jarvis (drafting messages,
          recording meetings, toggling integrations) this feed fills up.
        </div>
      ) : (
        <div className="activity__groups">
          {groupByDay(rows).map((group) => (
            <section key={group.label} className="activity__group">
              <h3 className="activity__group-label">{group.label}</h3>
              <ul className="activity__list">
                {group.rows.map((row) =>
                  row.kind === 'send' ? (
                    <SendRow key={`send-${row.task.id}`} task={row.task} />
                  ) : (
                    <EventRow key={`event-${row.event.id}`} event={row.event} />
                  ),
                )}
              </ul>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Bucket rows into Today / Yesterday / This week / Earlier. Same
 * spirit as the Dashboard's CalendarTimeline grouping; rendered here
 * as `<h3>` separators between groups.
 */
function groupByDay(rows: Row[]): Array<{ label: string; rows: Row[] }> {
  if (rows.length === 0) return [];
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const today = startOfToday.getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const weekStart = today - 7 * 24 * 60 * 60 * 1000;
  const buckets: Record<string, Row[]> = {};
  for (const row of rows) {
    let key: string;
    if (row.ts >= today) key = 'Today';
    else if (row.ts >= yesterday) key = 'Yesterday';
    else if (row.ts >= weekStart) key = 'This week';
    else key = 'Earlier';
    if (!buckets[key]) buckets[key] = [];
    buckets[key]!.push(row);
  }
  const order = ['Today', 'Yesterday', 'This week', 'Earlier'];
  return order
    .filter((k) => buckets[k])
    .map((label) => ({ label, rows: buckets[label]! }));
}

function openObservatoryTask(id: string): void {
  window.dispatchEvent(
    new CustomEvent('jarvis:navigate', { detail: { tab: 'observatory' } }),
  );
  window.dispatchEvent(
    new CustomEvent('jarvis:focus-task', { detail: { taskId: id } }),
  );
}

function SendRow({ task }: { task: TaskSummary }) {
  const channel = inferChannel(task.inputPreview);
  return (
    <li>
      <button
        className="activity__row"
        onClick={() => openObservatoryTask(task.id)}
        title="Open transcript"
      >
        <StatusBadge status={statusKind(task)} />
        {channel && <ChannelChip channel={channel} />}
        <span className="activity__preview" title={task.inputPreview}>
          {task.inputPreview || '(empty prompt)'}
        </span>
        <span className="activity__time">{formatRel(task.startedAt)}</span>
      </button>
    </li>
  );
}

/**
 * Per-kind handler maps an ActivityEvent.kind to a navigation action
 * + a short "category" label that drives the badge color.
 */
const EVENT_KIND_META: Record<
  string,
  {
    category:
      | 'note'
      | 'meeting'
      | 'integration'
      | 'inbox'
      | 'reminder'
      | 'dedupe'
      | 'other';
    label: string;
  }
> = {
  'note.created': { category: 'note', label: 'note' },
  'note.archived': { category: 'note', label: 'note · archive' },
  'note.restored': { category: 'note', label: 'note · restore' },
  'note.deleted': { category: 'note', label: 'note · delete' },
  'meeting.started': { category: 'meeting', label: 'meeting' },
  'meeting.finished': { category: 'meeting', label: 'meeting' },
  'mcp.enabled': { category: 'integration', label: 'integration · on' },
  'mcp.disabled': { category: 'integration', label: 'integration · off' },
  'mcp.removed': { category: 'integration', label: 'integration · remove' },
  'mcp.added': { category: 'integration', label: 'integration · add' },
  'mcp.updated': { category: 'integration', label: 'integration · update' },
  'mcp.file-replaced': { category: 'integration', label: 'integration · file replace' },
  'inbox.cleared': { category: 'inbox', label: 'inbox · clear' },
  'inbox.dismissed': { category: 'inbox', label: 'inbox · dismiss' },
  'inbox.restored': { category: 'inbox', label: 'inbox · restore' },
  'reminder.created': { category: 'reminder', label: 'reminder' },
  'reminder.scheduled': { category: 'reminder', label: 'reminder · scheduled' },
  'reminder.cancelled': { category: 'reminder', label: 'reminder · cancel' },
  'reminder.fired': { category: 'reminder', label: 'reminder · fired' },
  'reminder.done': { category: 'reminder', label: 'reminder · done' },
  'dedupe.scanned': { category: 'dedupe', label: 'dedupe · scan' },
  'module.enabled': { category: 'integration', label: 'module · on' },
  'module.disabled': { category: 'integration', label: 'module · off' },
  'module.settings-changed': { category: 'integration', label: 'module · settings' },
  'routine.auto-seeded': { category: 'integration', label: 'routine · auto-seeded' },
  'routine.created': { category: 'integration', label: 'routine · created' },
  'routine.updated': { category: 'integration', label: 'routine · updated' },
  'routine.deleted': { category: 'integration', label: 'routine · deleted' },
  'routine.ran-manually': { category: 'integration', label: 'routine · run now' },
  'skill.created': { category: 'integration', label: 'skill · created' },
  'skill.edited': { category: 'integration', label: 'skill · edited' },
  'skill.deleted': { category: 'integration', label: 'skill · deleted' },
  'jarvis-file.written': { category: 'integration', label: 'file · edited' },
};

function EventRow({ event }: { event: ActivityEvent }) {
  const meta = EVENT_KIND_META[event.kind] ?? {
    category: 'other' as const,
    label: event.kind,
  };
  const onClick = () => {
    // Notes / meetings → jump to the relevant module page.
    if (event.kind.startsWith('note.')) {
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', {
          detail: { tab: 'settings', moduleId: 'quick-note' },
        }),
      );
      return;
    }
    if (event.kind.startsWith('meeting.')) {
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', {
          detail: { tab: 'settings', moduleId: 'meeting-recorder' },
        }),
      );
      return;
    }
    if (event.kind.startsWith('mcp.')) {
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', { detail: { tab: 'settings' } }),
      );
      return;
    }
    if (event.kind.startsWith('inbox.')) {
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', { detail: { tab: 'inbox' } }),
      );
      return;
    }
    if (event.kind.startsWith('reminder.')) {
      // Reminders surface in the Inbox tab (time-pressured rows there).
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', { detail: { tab: 'inbox' } }),
      );
      return;
    }
    if (event.kind.startsWith('dedupe.')) {
      // Dedupe suggestions land in the Inbox.
      window.dispatchEvent(
        new CustomEvent('jarvis:navigate', { detail: { tab: 'inbox' } }),
      );
      return;
    }
  };
  return (
    <li>
      <button className="activity__row" onClick={onClick} title={event.kind}>
        <span
          className={`activity__cat activity__cat--${meta.category}`}
          title={meta.label}
        >
          {meta.label}
        </span>
        <span className="activity__preview" title={event.label}>
          {event.label}
        </span>
        <span className="activity__time">{formatRel(event.ts)}</span>
      </button>
    </li>
  );
}

type StatusKind = 'in-progress' | 'awaiting' | 'sent' | 'failed' | 'cancelled';

function statusKind(t: TaskSummary): StatusKind {
  if (t.status === 'errored') return 'failed';
  if (t.status === 'aborted') return 'cancelled';
  if (t.status === 'completed') return 'sent';
  if (t.awaitingInput) return 'awaiting';
  return 'in-progress';
}

const STATUS_LABEL: Record<StatusKind, string> = {
  'in-progress': 'drafting',
  awaiting: 'waiting on you',
  sent: 'sent',
  failed: 'failed',
  cancelled: 'cancelled',
};

function StatusBadge({ status }: { status: StatusKind }) {
  return (
    <span
      className={`activity__status activity__status--${status}`}
      title={STATUS_LABEL[status]}
    >
      <span className="activity__status-dot" />
      {STATUS_LABEL[status]}
    </span>
  );
}

type Channel = 'slack' | 'gmail' | 'imessage';

const CHANNEL_LABEL: Record<Channel, string> = {
  slack: 'Slack',
  gmail: 'Email',
  imessage: 'iMessage',
};

function ChannelChip({ channel }: { channel: Channel }) {
  return (
    <span className={`activity__channel activity__channel--${channel}`}>
      {CHANNEL_LABEL[channel]}
    </span>
  );
}

function inferChannel(input: string): Channel | null {
  if (!input) return null;
  const lower = input.toLowerCase();
  if (/\bslack\b|\bdm\b|\bping\b/.test(lower)) return 'slack';
  if (/\bemail\b|\bgmail\b|\bmail\b/.test(lower)) return 'gmail';
  if (/\bimessage\b|\btext\b|\bsms\b/.test(lower)) return 'imessage';
  return null;
}

function formatRel(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  const m = Math.round(diff / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

/**
 * Filter chips above the feed. Single-select: "All" or one category.
 * Selection persists to localStorage so the filter survives a reload.
 * Chip labels carry live counts so the user can decide what to scope
 * to without skimming the rows.
 */
const FILTER_CHIPS: Array<{
  value: Exclude<CategoryFilter, null>;
  label: string;
}> = [
  { value: 'send', label: 'Sends' },
  { value: 'reminder', label: 'Reminders' },
  { value: 'note', label: 'Notes' },
  { value: 'meeting', label: 'Meetings' },
  { value: 'integration', label: 'Integrations' },
  { value: 'inbox', label: 'Inbox' },
  { value: 'dedupe', label: 'Dedupe' },
];

function CategoryFilterStrip({
  active,
  counts,
  onChange,
}: {
  active: CategoryFilter;
  counts: Record<string, number>;
  onChange: (next: CategoryFilter) => void;
}) {
  return (
    <div className="activity__filters" role="tablist">
      <button
        className={`activity__filter${active === null ? ' activity__filter--active' : ''}`}
        onClick={() => onChange(null)}
      >
        All
      </button>
      {FILTER_CHIPS.map((c) => {
        const n = counts[c.value] ?? 0;
        if (n === 0) return null; // hide categories with no rows so the strip stays uncluttered
        return (
          <button
            key={c.value}
            className={`activity__filter activity__filter--${c.value}${
              active === c.value ? ' activity__filter--active' : ''
            }`}
            onClick={() => onChange(active === c.value ? null : c.value)}
          >
            {c.label}
            <span className="activity__filter-count">{n}</span>
          </button>
        );
      })}
    </div>
  );
}
