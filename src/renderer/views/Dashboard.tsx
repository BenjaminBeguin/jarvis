import { useEffect, useMemo, useState } from 'react';

import type { JarvisFileEntry, Reminder, TaskSummary } from '../../shared/types';
import { formatRelative } from './TaskList';

interface Props {
  tasks: TaskSummary[];
  reminders: Reminder[];
  onSelectTask: (id: string) => void;
  onCancelReminder: (id: string) => void;
}

/**
 * "What's happening right now" command-center view. Shows live tasks,
 * sessions awaiting your reply, pending scheduled/reminders, and recent
 * meeting + note files at a glance. Click anything to drill in.
 */
export function Dashboard({ tasks, reminders, onSelectTask, onCancelReminder }: Props) {
  const live = useMemo(
    () =>
      tasks
        .filter((t) => t.status === 'running' && t.origin !== 'external')
        .sort((a, b) => b.startedAt - a.startedAt),
    [tasks],
  );
  const awaiting = useMemo(
    () =>
      tasks
        .filter((t) => t.awaitingInput)
        .sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt)),
    [tasks],
  );
  const externalLive = useMemo(
    () =>
      tasks
        .filter((t) => t.origin === 'external' && t.status === 'running' && !t.awaitingInput)
        .sort((a, b) => b.startedAt - a.startedAt),
    [tasks],
  );
  const pending = useMemo(
    () =>
      reminders
        .filter((r) => r.status === 'pending')
        .sort((a, b) => a.fireAt - b.fireAt),
    [reminders],
  );

  const [meetings, setMeetings] = useState<JarvisFileEntry[]>([]);
  const [notes, setNotes] = useState<JarvisFileEntry[]>([]);
  useEffect(() => {
    const refresh = () => {
      void window.jarvis
        .listJarvisDir('meetings')
        .then((entries) =>
          setMeetings(
            entries
              .filter((e) => !e.isDir && e.name.endsWith('.md'))
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
              .slice(0, 5),
          ),
        )
        .catch(() => setMeetings([]));
      void window.jarvis
        .listJarvisDir('notes')
        .then((entries) =>
          setNotes(
            entries
              .filter((e) => !e.isDir && e.name.endsWith('.md'))
              .sort((a, b) => b.mtimeMs - a.mtimeMs)
              .slice(0, 5),
          ),
        )
        .catch(() => setNotes([]));
    };
    refresh();
    // Poll lightly so recent-file panels stay fresh without per-module IPC.
    const t = setInterval(refresh, 20_000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="dashboard">
      <DashCard
        title="Live"
        accent="cyan"
        count={live.length}
        empty="Nothing running. ⌘⇧J to deploy."
      >
        {live.map((t) => (
          <button
            key={t.id}
            className="dashboard__row"
            onClick={() => onSelectTask(t.id)}
          >
            <span className="dashboard__row-dot dashboard__row-dot--live" />
            <span className="dashboard__row-title">{rowTitle(t)}</span>
            <span className="dashboard__row-meta">{formatRelative(t.startedAt)}</span>
          </button>
        ))}
      </DashCard>

      <DashCard
        title="Awaiting your reply"
        accent="warn"
        count={awaiting.length}
        empty="Nothing waiting on you."
      >
        {awaiting.map((t) => (
          <button
            key={t.id}
            className="dashboard__row"
            onClick={() => onSelectTask(t.id)}
          >
            <span className="dashboard__row-dot dashboard__row-dot--awaiting" />
            <span className="dashboard__row-title">{rowTitle(t)}</span>
            <span className="dashboard__row-meta">
              {formatRelative(t.endedAt ?? t.startedAt)}
            </span>
          </button>
        ))}
      </DashCard>

      <DashCard
        title="Scheduled"
        accent="warn"
        count={pending.length}
        empty="No scheduled actions or reminders."
      >
        {pending.map((r) => (
          <div key={r.id} className="dashboard__row dashboard__row--reminder">
            <span className="dashboard__row-glyph">
              {r.mode === 'scheduled' ? '⚡' : '⏰'}
            </span>
            <span className="dashboard__row-title">
              {r.body.length > 60 ? `${r.body.slice(0, 59)}…` : r.body}
            </span>
            <span className="dashboard__row-meta">{formatRelative(r.fireAt)}</span>
            <button
              className="dashboard__row-cancel"
              title="Cancel"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`Cancel: "${r.body}"?`)) onCancelReminder(r.id);
              }}
            >
              ×
            </button>
          </div>
        ))}
      </DashCard>

      <DashCard
        title="Other agents"
        accent="good"
        count={externalLive.length}
        empty="No external Claude sessions running."
      >
        {externalLive.map((t) => (
          <button
            key={t.id}
            className="dashboard__row"
            onClick={() => onSelectTask(t.id)}
          >
            <span className="dashboard__row-dot dashboard__row-dot--agent" />
            <span className="dashboard__row-title">{rowTitle(t)}</span>
            <span className="dashboard__row-meta">{formatRelative(t.startedAt)}</span>
          </button>
        ))}
      </DashCard>

      <DashCard
        title="Recent meetings"
        accent="dim"
        count={meetings.length}
        empty="No meetings yet."
      >
        {meetings.map((m) => (
          <div key={m.name} className="dashboard__row dashboard__row--file">
            <span className="dashboard__row-glyph">🎙</span>
            <span className="dashboard__row-title">{m.name.replace(/\.md$/, '')}</span>
            <span className="dashboard__row-meta">{formatRelative(m.mtimeMs)}</span>
          </div>
        ))}
      </DashCard>

      <DashCard
        title="Recent notes"
        accent="dim"
        count={notes.length}
        empty="No notes yet. /note in the palette."
      >
        {notes.map((n) => (
          <div key={n.name} className="dashboard__row dashboard__row--file">
            <span className="dashboard__row-glyph">✎</span>
            <span className="dashboard__row-title">{n.name.replace(/\.md$/, '')}</span>
            <span className="dashboard__row-meta">{formatRelative(n.mtimeMs)}</span>
          </div>
        ))}
      </DashCard>
    </div>
  );
}

function rowTitle(t: TaskSummary): string {
  const head = t.title || t.inputPreview || 'untitled';
  return head.length > 80 ? `${head.slice(0, 79)}…` : head;
}

interface CardProps {
  title: string;
  accent: 'cyan' | 'warn' | 'good' | 'dim';
  count: number;
  empty: string;
  children: React.ReactNode;
}

function DashCard({ title, accent, count, empty, children }: CardProps) {
  const arr = Array.isArray(children) ? children : [children];
  const hasContent = arr.some(Boolean);
  return (
    <section className={`dashboard__card dashboard__card--${accent}`}>
      <header className="dashboard__card-head">
        <span className="dashboard__card-title">{title}</span>
        <span className="dashboard__card-count">{count}</span>
      </header>
      <div className="dashboard__card-body">
        {hasContent ? children : <div className="dashboard__empty">{empty}</div>}
      </div>
    </section>
  );
}
