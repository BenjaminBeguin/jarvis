import { useEffect, useMemo, useState } from 'react';

import type { TaskSummary } from '../../shared/types';
import { TaskDetail } from './TaskDetail';

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function Observatory() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  useEffect(() => {
    void window.jarvis.listTasks().then(setTasks);
    const off = window.jarvis.onTaskStatus((summary) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === summary.id);
        if (idx === -1) return [summary, ...prev];
        const next = prev.slice();
        next[idx] = summary;
        return next;
      });
    });
    return off;
  }, []);

  useEffect(() => {
    if (!selectedId && tasks[0]) setSelectedId(tasks[0].id);
  }, [tasks, selectedId]);

  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  return (
    <div className="app">
      <aside className="sidebar">
        <header>
          <h1>Tasks</h1>
          <span className="shortcut">⌘⇧J</span>
        </header>
        <div className="task-list">
          {tasks.length === 0 && (
            <div style={{ padding: 16, color: 'var(--text-faint)', fontSize: 12 }}>
              No tasks yet. Hit ⌘⇧J to launch one.
            </div>
          )}
          {tasks.map((t) => (
            <div
              key={t.id}
              className={`task-row${selectedId === t.id ? ' active' : ''}`}
              onClick={() => setSelectedId(t.id)}
            >
              <div className="task-row__title">{t.title}</div>
              <div className="task-row__meta">
                <span className={`status-dot status-dot--${t.status}`} />
                <span>{t.status}</span>
                <span>·</span>
                <span>{formatTime(t.startedAt)}</span>
                {t.costUsd > 0 && (
                  <>
                    <span>·</span>
                    <span>${t.costUsd.toFixed(4)}</span>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </aside>
      {selected ? (
        <TaskDetail task={selected} />
      ) : (
        <div className="empty">Select a task or press ⌘⇧J to launch.</div>
      )}
    </div>
  );
}
