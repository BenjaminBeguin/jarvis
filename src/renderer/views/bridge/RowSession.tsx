import { useEffect, useMemo, useState } from 'react';

import type { TaskEvent, TaskSummary } from '../../../shared/types';

/**
 * RowSession — inline live-session panel rendered under a Bridge queue
 * row after the user clicks a "▶ Run agent" action chip. Same task
 * still streams to the Observatory in the background; this panel is
 * the in-place feedback so the user knows the agent is working
 * without context-switching tabs.
 *
 * Renders:
 *   - Status pill (RUNNING / AWAITING / DONE / ERRORED / ABORTED)
 *   - Tail of the latest assistant text — last ~200 chars, updated as
 *     the SDK streams. Gives the user the gist without dragging them
 *     into the full transcript.
 *   - Cancel button (abortTask) while still running
 *   - "Open full ↗" link that jumps to the AI Agent tab focused on
 *     this task — for when the inline tail isn't enough.
 *
 * Self-managing: subscribes to onTaskEvent + onTaskStatus for its
 * taskId and tears down on unmount. The parent only needs to know the
 * taskId — no event plumbing required.
 */

interface Props {
  taskId: string;
  onCancel(taskId: string): void;
  onOpenFull(taskId: string): void;
}

export function RowSession({ taskId, onCancel, onOpenFull }: Props) {
  const [status, setStatus] = useState<TaskSummary | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);

  // Hydrate with whatever the runner already knows, then subscribe
  // for live updates.
  useEffect(() => {
    let cancelled = false;
    void window.jarvis.listTasks().then((all) => {
      if (cancelled) return;
      const found = all.find((t) => t.id === taskId);
      if (found) setStatus(found);
    });
    void window.jarvis.getTaskHistory(taskId).then((history) => {
      if (cancelled) return;
      setEvents(history);
    });
    const offStatus = window.jarvis.onTaskStatus((s) => {
      if (s.id !== taskId) return;
      setStatus(s);
    });
    const offEvent = window.jarvis.onTaskEvent(({ taskId: tid, event }) => {
      if (tid !== taskId) return;
      setEvents((prev) => [...prev, event]);
    });
    return () => {
      cancelled = true;
      offStatus();
      offEvent();
    };
  }, [taskId]);

  const tail = useMemo(() => extractTail(events), [events]);
  const phase: Phase = (() => {
    if (!status) return 'pending';
    if (status.status === 'completed') return 'done';
    if (status.status === 'errored') return 'errored';
    if (status.status === 'aborted') return 'aborted';
    if (status.awaitingInput) return 'awaiting';
    return 'running';
  })();
  const stillLive = phase === 'running' || phase === 'pending';

  return (
    <div className={`bridge-session bridge-session--${phase}`}>
      <div className="bridge-session__head">
        <span className={`bridge-session__pill bridge-session__pill--${phase}`}>
          <span className="bridge-session__dot" aria-hidden />
          {PHASE_LABEL[phase]}
        </span>
        {status?.skillId && (
          <span className="bridge-session__skill">{status.skillId}</span>
        )}
        <span className="bridge-session__spacer" />
        {stillLive && (
          <button
            type="button"
            className="bridge-session__cancel"
            onClick={() => onCancel(taskId)}
            title="Abort this agent task"
          >
            ✕ Cancel
          </button>
        )}
        <button
          type="button"
          className="bridge-session__open"
          onClick={() => onOpenFull(taskId)}
          title="Open the full transcript in the AI Agent tab"
        >
          Open full ↗
        </button>
      </div>
      {tail && (
        <p className="bridge-session__tail" title={tail}>
          {tail}
        </p>
      )}
    </div>
  );
}

type Phase = 'pending' | 'running' | 'awaiting' | 'done' | 'errored' | 'aborted';
const PHASE_LABEL: Record<Phase, string> = {
  pending: 'STARTING',
  running: 'RUNNING',
  awaiting: 'WAITING ON YOU',
  done: 'DONE',
  errored: 'ERRORED',
  aborted: 'CANCELLED',
};

/**
 * Pull the most recent assistant text out of the streaming event
 * log. The SDK emits `assistant` events with `message.content[]`
 * arrays mixing text + tool_use blocks; we want the last text run
 * so the user sees "what the agent is saying right now" rather
 * than "what tool it last called."
 */
function extractTail(events: TaskEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as unknown as {
      type?: string;
      message?: {
        content?: Array<{ type?: string; text?: string }>;
      };
    };
    if (e?.type !== 'assistant') continue;
    const content = e.message?.content;
    if (!Array.isArray(content)) continue;
    const textPart = content
      .filter((p) => p?.type === 'text' && typeof p.text === 'string')
      .map((p) => p.text as string)
      .join('\n')
      .trim();
    if (!textPart) continue;
    const collapsed = textPart.replace(/\s+/g, ' ');
    return collapsed.length > 220
      ? `…${collapsed.slice(collapsed.length - 220)}`
      : collapsed;
  }
  return null;
}
