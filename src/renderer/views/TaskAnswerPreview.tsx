import { useEffect, useMemo, useState } from 'react';

import type { TaskEvent } from '../../shared/types';
import { MarkdownDoc } from './MarkdownText';

/**
 * Inline preview of a task that surfaces ONLY the assistant's text — the
 * "answer," not the pipeline. Tool calls + tool results stay hidden;
 * users who want the full pipeline click the "Open full transcript →"
 * link to land on the Observatory's TaskDetail.
 *
 * Streams events live so a still-running task fills in as it goes.
 * Reused everywhere a routine's last task surface is rendered (the
 * Routines history pane and the Dashboard freeform routine card).
 */
export function TaskAnswerPreview({
  taskId,
  openLabel = 'open full transcript →',
  compact = false,
}: {
  taskId: string;
  /** Label of the secondary "see the full pipeline" link. */
  openLabel?: string;
  /** Trim the assistant text after N characters when true — used in the
   * Dashboard where space is tight. The link still opens the full one. */
  compact?: boolean;
}) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [status, setStatus] = useState<string>('');

  useEffect(() => {
    let cancelled = false;
    void window.jarvis.getTaskHistory(taskId).then((evts) => {
      if (!cancelled) setEvents(evts);
    });
    const off = window.jarvis.onTaskEvent(({ taskId: id, event }) => {
      if (id !== taskId) return;
      setEvents((prev) => {
        if (prev.some((e) => e.seq === event.seq)) return prev;
        return [...prev, event];
      });
    });
    const offStatus = window.jarvis.onTaskStatus((summary) => {
      if (summary.id !== taskId) return;
      setStatus(summary.awaitingInput ? 'awaiting' : summary.status);
    });
    void window.jarvis.listTasks().then((all) => {
      if (cancelled) return;
      const t = all.find((x) => x.id === taskId);
      if (t) setStatus(t.awaitingInput ? 'awaiting' : t.status);
    });
    return () => {
      cancelled = true;
      off();
      offStatus();
    };
  }, [taskId]);

  const assistantText = useMemo(() => {
    const parts: string[] = [];
    for (const e of events) {
      const msg = e.msg as
        | { type?: string; message?: { content?: unknown } }
        | undefined;
      if (msg?.type !== 'assistant') continue;
      const content = msg.message?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          parts.push(block['text'] as string);
        }
      }
    }
    const joined = parts.join('\n').trim();
    if (!compact || joined.length <= 1200) return joined;
    return joined.slice(0, 1200) + '\n\n…';
  }, [events, compact]);

  return (
    <div className="task-answer-preview">
      <div className="task-answer-preview__head">
        <span className="task-answer-preview__status">
          ● {status || 'loading'}
        </span>
        <button
          className="briefings__schedule-link"
          onClick={() => void window.jarvis.openObservatory(taskId)}
        >
          {openLabel}
        </button>
      </div>
      {assistantText ? (
        <MarkdownDoc>{assistantText}</MarkdownDoc>
      ) : (
        <div className="briefings__empty">
          {status === 'running' ? 'Streaming…' : 'No assistant text yet.'}
        </div>
      )}
    </div>
  );
}
