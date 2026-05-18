import { useEffect, useMemo, useState } from 'react';

import type { TaskStatus, TaskSummary } from '../../shared/types';

type Filter = 'all' | 'live' | 'awaiting' | 'mine' | 'external' | 'background';

interface Props {
  tasks: TaskSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export function TaskList({ tasks, selectedId, onSelect }: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  // Re-render every 30s so relative timestamps stay accurate.
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const visible = useMemo(
    () =>
      tasks
        .filter((t) => matchesFilter(t, filter))
        .sort((a, b) => b.startedAt - a.startedAt),
    [tasks, filter],
  );

  // Counts mirror what each filter ends up showing — i.e. all the
  // non-background filters exclude background tasks. Without this the
  // "all" count says e.g. 4173 while the visible list has 20.
  const counts = useMemo(
    () => ({
      all: tasks.filter((t) => !t.background).length,
      live: tasks.filter((t) => !t.background && t.status === 'running').length,
      awaiting: tasks.filter((t) => !t.background && t.awaitingInput).length,
      mine: tasks.filter((t) => !t.background && t.origin !== 'external').length,
      external: tasks.filter((t) => !t.background && t.origin === 'external').length,
      background: tasks.filter((t) => t.background).length,
    }),
    [tasks],
  );

  return (
    <section className="task-list-view">
      <header className="task-list-view__filters">
        {(
          ['all', 'live', 'awaiting', 'mine', 'external', 'background'] as Filter[]
        ).map((f) => (
          <button
            key={f}
            className={`task-list-view__filter${filter === f ? ' task-list-view__filter--active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f} <span className="task-list-view__count">{counts[f]}</span>
          </button>
        ))}
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
  // The background tab is the only place these surface — everywhere
  // else we treat them as if they didn't exist so the default view
  // isn't drowned by Claude Code's own metadata writes.
  if (f === 'background') return !!t.background;
  if (t.background) return false;
  if (f === 'all') return true;
  if (f === 'live') return t.status === 'running';
  if (f === 'awaiting') return !!t.awaitingInput;
  if (f === 'mine') return t.origin !== 'external';
  if (f === 'external') return t.origin === 'external';
  return true;
}

function statusClass(t: TaskSummary): TaskStatus {
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
