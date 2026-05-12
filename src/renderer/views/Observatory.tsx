import { useEffect, useMemo, useState } from 'react';

import type { TaskSummary } from '../../shared/types';
import { Constellation } from './Constellation';
import { TaskDetail } from './TaskDetail';

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
      <Constellation
        tasks={tasks}
        selectedId={selectedId}
        onSelect={setSelectedId}
      />
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
            <TaskDetail task={selected} />
          </>
        )}
      </aside>
    </div>
  );
}
