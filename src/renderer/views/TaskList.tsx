import { useEffect, useMemo, useState } from 'react';

import type { TaskStatus, TaskSummary } from '../../shared/types';

type Filter = 'all' | 'live' | 'awaiting' | 'mine' | 'external';

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

  const counts = useMemo(
    () => ({
      all: tasks.length,
      live: tasks.filter((t) => t.status === 'running').length,
      awaiting: tasks.filter((t) => t.awaitingInput).length,
      mine: tasks.filter((t) => t.origin !== 'external').length,
      external: tasks.filter((t) => t.origin === 'external').length,
    }),
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
  const originLabel =
    task.origin === 'external'
      ? 'agent'
      : task.origin === 'routine'
      ? 'routine'
      : task.origin === 'voice'
      ? 'voice'
      : 'palette';
  return (
    <button
      className={`task-list-view__row${active ? ' task-list-view__row--active' : ''}${task.awaitingInput ? ' task-list-view__row--awaiting' : ''}`}
      onClick={onClick}
      title={new Date(task.startedAt).toLocaleString()}
    >
      <span className={`status-dot status-dot--${statusClass(task)}`} />
      <span className="task-list-view__title">{task.title}</span>
      <span className="task-list-view__origin">{originLabel}</span>
      {task.awaitingInput && (
        <span className="task-list-view__awaiting">awaiting</span>
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
