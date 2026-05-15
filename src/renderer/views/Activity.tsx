import { useEffect, useMemo, useState } from 'react';

import type { TaskSummary } from '../../shared/types';

/**
 * Activity tab — Phase 1.
 *
 * For now, this is "everything you did with /send": each row is one task
 * spawned by the send skill. Status (running / sent / failed / cancelled)
 * comes straight from task.status; the prompt preview is what you typed
 * into the palette. Click a row to open the full transcript in Observatory
 * — that's where tool calls, drafts, and the actual confirmation/send
 * trail live.
 *
 * Phase 2 will widen this into a true event log (meeting open/close,
 * note removed, integration disabled, …) backed by a new SQLite events
 * table that modules write to. For now the data is task-derived; no new
 * schema, no new IPC. We're rendering rows the system already has.
 */
export function Activity() {
  const [tasks, setTasks] = useState<TaskSummary[]>([]);

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

  const rows = useMemo(
    () =>
      tasks
        .filter((t) => t.skillId === 'send')
        .sort((a, b) => b.startedAt - a.startedAt)
        .slice(0, 50),
    [tasks],
  );

  const openTask = (id: string) => {
    // Switch the Shell to Observatory, then ping Observatory to select
    // this id. Cross-component coordination via window events — same
    // pattern shellNav uses elsewhere.
    window.dispatchEvent(
      new CustomEvent('jarvis:navigate', { detail: { tab: 'observatory' } }),
    );
    window.dispatchEvent(
      new CustomEvent('jarvis:focus-task', { detail: { taskId: id } }),
    );
  };

  return (
    <section className="activity">
      <header className="activity__header">
        <div>
          <h2>ACTIVITY</h2>
          <p>
            Things you've done through Jarvis. Today: every <code>/send</code>{' '}
            with its status and prompt. Coming next: meetings, notes,
            integration toggles, and the rest of the event log.
          </p>
        </div>
        <div className="activity__count">
          {rows.length} {rows.length === 1 ? 'message' : 'messages'}
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="activity__empty">
          No <code>/send</code> activity yet. When you draft a message through
          the palette, it'll show up here with its delivery status.
        </div>
      ) : (
        <ul className="activity__list">
          {rows.map((task) => (
            <ActivityRow key={task.id} task={task} onOpen={() => openTask(task.id)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ActivityRow({
  task,
  onOpen,
}: {
  task: TaskSummary;
  onOpen: () => void;
}) {
  const channel = inferChannel(task.inputPreview);
  return (
    <li>
      <button className="activity__row" onClick={onOpen} title="Open transcript">
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

/**
 * Best-effort channel detection from the raw palette input. The send
 * skill's UX teaches users to name the channel ("on slack", "email
 * mom personal"), so a keyword scan covers most cases. If we can't
 * tell, we just omit the chip — Phase 2 will read the channel out of
 * the task's structured events instead of guessing.
 */
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
