import { useEffect, useMemo, useState } from 'react';

import type { Reminder, TaskSummary } from '../../shared/types';
import { Constellation } from './Constellation';
import { Dashboard } from './Dashboard';
import { TaskDetail } from './TaskDetail';
import { TaskList } from './TaskList';

type ViewMode = 'dashboard' | 'constellation' | 'list';

export function Observatory() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('dashboard');

  useEffect(() => {
    void window.jarvis.listTasks().then(setTasks);
    void window.jarvis.listReminders().then(setReminders);
    const offReminders = window.jarvis.onRemindersChanged(setReminders);
    const offStatus = window.jarvis.onTaskStatus((summary) => {
      setTasks((prev) => {
        const idx = prev.findIndex((t) => t.id === summary.id);
        if (idx === -1) return [summary, ...prev];
        const next = prev.slice();
        next[idx] = summary;
        return next;
      });
    });
    const offRemoved = window.jarvis.onTaskRemoved((taskId) => {
      setTasks((prev) => prev.filter((t) => t.id !== taskId));
      setSelectedId((id) => (id === taskId ? null : id));
    });
    // Allow other windows (HUD ↗, main process) to focus a specific task.
    const offFocus = window.jarvis.onObservatoryFocusTask((taskId) => {
      setSelectedId(taskId);
    });
    return () => {
      offStatus();
      offRemoved();
      offFocus();
      offReminders();
    };
  }, []);

  const selected = useMemo(
    () => tasks.find((t) => t.id === selectedId) ?? null,
    [tasks, selectedId],
  );

  // If the user selected a node and it leaves the active set later (e.g.
  // session went idle and dropped off), keep the panel open with whatever
  // we still have for that id — the transcript stays meaningful.
  useEffect(() => {
    if (selectedId && !tasks.some((t) => t.id === selectedId)) {
      setSelectedId(null);
    }
  }, [tasks, selectedId]);

  useEffect(() => {
    if (!selectedId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelectedId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId]);

  return (
    <div className="observatory">
      <div className="observatory__viewbar">
        <button
          className={`observatory__view-btn${view === 'dashboard' ? ' observatory__view-btn--active' : ''}`}
          onClick={() => setView('dashboard')}
          title="Dashboard view"
        >
          ▦ dashboard
        </button>
        <button
          className={`observatory__view-btn${view === 'constellation' ? ' observatory__view-btn--active' : ''}`}
          onClick={() => setView('constellation')}
          title="Constellation view"
        >
          ◉ map
        </button>
        <button
          className={`observatory__view-btn${view === 'list' ? ' observatory__view-btn--active' : ''}`}
          onClick={() => setView('list')}
          title="List view"
        >
          ☰ list
        </button>
      </div>
      <div className="observatory__main">
        {view === 'dashboard' ? (
          <Dashboard
            tasks={tasks}
            reminders={reminders}
            onSelectTask={setSelectedId}
            onCancelReminder={(id) => void window.jarvis.cancelReminder(id)}
          />
        ) : view === 'constellation' ? (
          <Constellation
            tasks={tasks}
            reminders={reminders}
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCancelReminder={(id) => void window.jarvis.cancelReminder(id)}
          />
        ) : (
          <TaskList
            tasks={tasks}
            selectedId={selectedId}
            onSelect={setSelectedId}
          />
        )}
      </div>
      <aside
        className={`observatory__panel${selected ? ' observatory__panel--open' : ''}`}
      >
        {selected && (
          <>
            <button
              className="observatory__close"
              onClick={() => setSelectedId(null)}
              aria-label="Close"
              title="Close (Esc)"
            >
              ×
            </button>
            <TaskDetail task={selected} onSelectTask={setSelectedId} />
          </>
        )}
      </aside>
    </div>
  );
}
