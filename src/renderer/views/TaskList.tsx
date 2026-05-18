import { useEffect, useMemo, useState } from 'react';

import type { TaskStatus, TaskSummary } from '../../shared/types';

type Filter = 'all' | 'live' | 'awaiting' | 'mine' | 'external';

/**
 * A task is "live" only if it's actually doing something the user
 * might care about right now — running AND (awaiting input OR started
 * recently). status='running' alone isn't enough: orphaned tasks
 * whose terminal SDK event got dropped stay in `running` forever
 * (we've seen 22h-old routine fires still flagged live). Using the
 * start time as the freshness proxy is rough but defensible: a real
 * task that takes >15 min without the awaitingInput flag is rare; an
 * orphaned routine that "started 22h ago" is obvious.
 */
const LIVE_STALE_MS = 15 * 60 * 1000;

function isLive(t: TaskSummary, now: number): boolean {
  if (t.status !== 'running') return false;
  if (t.awaitingInput) return true;
  return now - t.startedAt < LIVE_STALE_MS;
}

interface Props {
  tasks: TaskSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function TaskList({ tasks, selectedId, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  // Off by default — seeing thousands of Claude Code metadata writes
  // pop up is alarming. Flip on if you want to peek at the archive.
  const [showBackground, setShowBackground] = useState(false);
  // Re-render every 30s so relative timestamps stay accurate.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const visible = useMemo(
    () =>
      tasks
        .filter((t) => (showBackground || !t.background) && matchesFilter(t, filter))
        .sort((a, b) => b.startedAt - a.startedAt),
    [tasks, filter, showBackground],
  );

  // Counts mirror what each filter ends up showing — i.e. honour
  // the showBackground toggle. Without that the "all" count says
  // e.g. 4173 while the visible list has 20.
  const counts = useMemo(() => {
    const now = Date.now();
    const pool = showBackground
      ? tasks
      : tasks.filter((t) => !t.background);
    return {
      all: pool.length,
      live: pool.filter((t) => isLive(t, now)).length,
      awaiting: pool.filter((t) => t.awaitingInput).length,
      mine: pool.filter((t) => t.origin !== 'external').length,
      external: pool.filter((t) => t.origin === 'external').length,
    };
  }, [tasks, showBackground]);

  const backgroundCount = useMemo(
    () => tasks.filter((t) => t.background).length,
    [tasks],
  );

  return (
    <section className="task-list-view">
      <header className="task-list-view__filters">
        {(['all', 'live', 'awaiting', 'mine', 'external'] as Filter[]).map((f) => (
          <button
            key={f}
            className={`task-list-view__filter${filter === f ? ' task-list-view__filter--active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f} <span className="task-list-view__count">{counts[f]}</span>
          </button>
        ))}
        {backgroundCount > 0 && (
          <label
            className={`task-list-view__bg-toggle${showBackground ? ' task-list-view__bg-toggle--on' : ''}`}
            title="Show Claude Code's background metadata writes (AI-title backfill etc.) alongside real activity"
          >
            <input
              type="checkbox"
              checked={showBackground}
              onChange={(e) => setShowBackground(e.target.checked)}
            />
            background?{' '}
            <span className="task-list-view__count">{backgroundCount}</span>
          </label>
        )}
      </header>
      <div className="task-list-view__rows">
        {visible.length === 0 && (
          <div className="task-list-view__empty">No tasks match this filter.</div>
        )}
        {visible.map((task) => (
          <Row
            key={task.id}
            task={task}
            active={task.id === selectedId}
            onClick={() => onSelect(task.id)}
          />
        ))}
      </div>
    </section>
  );
}

interface RowProps {
  task: TaskSummary;
  active: boolean;
  onClick: () => void;
}

function Row({ task, active, onClick }: RowProps) {
  // The origin chip used to be the only provenance signal. Now that
  // tasks carry routineId / reminderId / projectName, prefer the
  // more specific link when present — "routine:daily-recap" tells
  // the user more than "routine" on its own.
  const originLabel = task.routineId
    ? `⟳ ${task.routineId}`
    : task.reminderId
    ? `⏰ reminder`
    : task.origin === 'external'
    ? 'agent'
    : task.origin === 'routine'
    ? 'routine'
    : task.origin === 'voice'
    ? 'voice'
    : 'palette';
  const titleParts = [new Date(task.startedAt).toLocaleString()];
  if (task.projectName) titleParts.push(`project: ${task.projectName}`);
  if (task.routineId) titleParts.push(`routine: ${task.routineId}`);
  if (task.reminderId) titleParts.push(`reminder: ${task.reminderId}`);
  // Defensive: terminal tasks aren't actually waiting even if the
  // flag is stale. Mirrors the guard in TaskDetail / AwaitingStrip.
  const isAwaiting =
    !!task.awaitingInput &&
    task.status !== 'completed' &&
    task.status !== 'errored' &&
    task.status !== 'aborted';
  return (
    <button
      className={`task-list-view__row${active ? ' task-list-view__row--active' : ''}${isAwaiting ? ' task-list-view__row--awaiting' : ''}`}
      onClick={onClick}
      title={titleParts.join(' · ')}
    >
      <span className={`status-dot status-dot--${statusClass(task)}`} />
      <span className="task-list-view__title">{task.title}</span>
      <span className="task-list-view__origin">{originLabel}</span>
      {isAwaiting && (
        <span className="task-list-view__awaiting">awaiting</span>
      )}
      {task.pooled && (
        <span
          className="task-list-view__pooled"
          title="Resumed a pooled SDK session — skipped the cold start"
        >
          ↪ pool
        </span>
      )}
      <span className="task-list-view__time">{formatRelative(task.startedAt)}</span>
      {task.costUsd > 0 && (
        <span className="task-list-view__cost">${task.costUsd.toFixed(4)}</span>
      )}
    </button>
  );
}

function matchesFilter(t: TaskSummary, f: Filter): boolean {
  if (f === 'all') return true;
  if (f === 'live') return isLive(t, Date.now());
  if (f === 'awaiting') return !!t.awaitingInput;
  if (f === 'mine') return t.origin !== 'external';
  if (f === 'external') return t.origin === 'external';
  return true;
}

function statusClass(t: TaskSummary): TaskStatus {
  // Match isLive(): a stale 'running' task gets a 'completed' dot so
  // the row doesn't visually pulse green for hours after the SDK
  // 'result' event got dropped. Doesn't mutate the underlying status
  // (Activity / cost still see the real value).
  if (t.status === 'running' && !isLive(t, Date.now())) return 'completed';
  return t.status;
}

/**
 * "2m ago" / "3h ago" / "May 13 12:30". Tunes density by recency — for
 * things within the last 24h we show relative, older absolute.
 */
export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
