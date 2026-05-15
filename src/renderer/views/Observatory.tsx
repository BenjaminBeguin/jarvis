import { useEffect, useMemo, useState } from 'react';

import type {
  JarvisFileEntry,
  Reminder,
  SkillSuggestion,
  TaskSummary,
} from '../../shared/types';
import { meetingRecorder, type MeetingState } from '../voice/MeetingRecorder';
import { Constellation } from './Constellation';
import { TaskDetail } from './TaskDetail';
import { TaskList } from './TaskList';
import { toast } from './Toaster';

type ViewMode = 'constellation' | 'list';

export function Observatory() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [recentNotes, setRecentNotes] = useState<JarvisFileEntry[]>([]);
  const [recentMeetings, setRecentMeetings] = useState<JarvisFileEntry[]>([]);
  const [meetingState, setMeetingState] = useState<MeetingState>(() => meetingRecorder.getState());
  const [skillSuggestions, setSkillSuggestions] = useState<SkillSuggestion[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('constellation');

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
    // Same focus signal but from sibling renderer views (Activity row
    // click etc.) — they fire a window event instead of round-tripping
    // through main since both views live in the same BrowserWindow.
    const onWindowFocus = (e: Event) => {
      const detail = (e as CustomEvent).detail as { taskId?: string };
      if (detail?.taskId) {
        setSelectedId(detail.taskId);
        setView('list');
      }
    };
    window.addEventListener('jarvis:focus-task', onWindowFocus);
    return () => {
      offStatus();
      offRemoved();
      offFocus();
      offReminders();
      window.removeEventListener('jarvis:focus-task', onWindowFocus);
    };
  }, []);

  // Pull recent notes + meetings for the constellation. Lightweight poll so
  // we don't need a per-module file-watch IPC; 30s is fine for files the
  // user just wrote.
  useEffect(() => {
    const refresh = () => {
      void window.jarvis
        .listJarvisDir('notes')
        .then((entries) =>
          setRecentNotes(
            entries
              .filter((e) => !e.isDir && e.name.endsWith('.md'))
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
              .slice(0, 6),
          ),
        )
        .catch(() => setRecentNotes([]));
      void window.jarvis
        .listJarvisDir('meetings')
        .then((entries) =>
          setRecentMeetings(
            entries
              .filter((e) => !e.isDir && e.name.endsWith('.md'))
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
              .slice(0, 4),
          ),
        )
        .catch(() => setRecentMeetings([]));
    };
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => clearInterval(t);
  }, []);

  // Subscribe to the in-process meeting recorder so the map can show a
  // pulsing "RECORDING" node while audio is being captured.
  useEffect(() => {
    return meetingRecorder.subscribe(setMeetingState);
  }, []);

  // Skill suggestion count — surfaced on the constellation core.
  useEffect(() => {
    void window.jarvis.listSkillSuggestions().then(setSkillSuggestions);
    return window.jarvis.onSkillSuggestionsChanged(setSkillSuggestions);
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
          className={`observatory__view-btn${view === 'constellation' ? ' observatory__view-btn--active' : ''}`}
          onClick={() => setView('constellation')}
          title="Constellation view — agents in space"
        >
          ◉ map
        </button>
        <button
          className={`observatory__view-btn${view === 'list' ? ' observatory__view-btn--active' : ''}`}
          onClick={() => setView('list')}
          title="List view — chronological agent history"
        >
          ☰ list
        </button>
      </div>
      <div className="observatory__main">
        {view === 'constellation' ? (
          <Constellation
            tasks={tasks}
            reminders={reminders}
            recentNotes={recentNotes}
            recentMeetings={recentMeetings}
            meetingState={meetingState}
            pendingSuggestionCount={
              skillSuggestions.filter((s) => s.status === 'pending').length
            }
            selectedId={selectedId}
            onSelect={setSelectedId}
            onCancelReminder={(id) => {
              void window.jarvis.cancelReminder(id);
              toast({ kind: 'info', message: 'Reminder cancelled' });
            }}
            onFireReminderNow={(id) => {
              void window.jarvis.fireReminderNow(id);
              toast({ message: 'Running now…' });
            }}
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
