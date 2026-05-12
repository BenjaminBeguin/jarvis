import { useEffect, useMemo, useState } from 'react';

import type { SkillSummary, TaskStatus, TaskSummary } from '../../shared/types';
import { TaskDetail } from './TaskDetail';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  if (sameDay) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

type StatusFilter = 'all' | TaskStatus;

export function Observatory() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [skillFilter, setSkillFilter] = useState<string>('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  useEffect(() => {
    void window.jarvis.listTasks().then(setTasks);
    const offStatus = window.jarvis.onTaskStatus((summary) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === summary.id);
        if (idx === -1) return [summary, ...prev];
        const next = prev.slice();
        next[idx] = summary;
        return next;
      });
    });
    void window.jarvis.listSkills().then(setSkills);
    const offSkills = window.jarvis.onSkillsChanged(setSkills);
    return () => {
      offStatus();
      offSkills();
    };
  }, []);

  const filtered = useMemo(() => {
    return tasks.filter((t) => {
      if (skillFilter && t.skillId !== skillFilter) return false;
      if (statusFilter !== 'all' && t.status !== statusFilter) return false;
      return true;
    });
  }, [tasks, skillFilter, statusFilter]);

  useEffect(() => {
    if (!selectedId && filtered[0]) setSelectedId(filtered[0].id);
    if (selectedId && !filtered.some((t) => t.id === selectedId)) {
      setSelectedId(filtered[0]?.id ?? null);
    }
  }, [filtered, selectedId]);

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
        <div className="filters">
          <select
            value={skillFilter}
            onChange={(e) => setSkillFilter(e.target.value)}
          >
            <option value="">All skills</option>
            {skills.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
          >
            <option value="all">Any status</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="errored">Errored</option>
            <option value="aborted">Aborted</option>
          </select>
        </div>
        <div className="task-list">
          {filtered.length === 0 && (
            <div className="task-list__empty">
              {tasks.length === 0
                ? 'No tasks yet. Hit ⌘⇧J to launch one.'
                : 'No tasks match the current filters.'}
            </div>
          )}
          {filtered.map((t) => (
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
