import { useEffect, useMemo, useRef, useState } from 'react';

import type { TaskEvent, TaskSummary } from '../../shared/types';
import { MarkdownText } from './MarkdownText';

/**
 * In-window session viewer that slides over the current tab without
 * navigating away. Mounted at the Shell level so any component can
 * pop a Claude session open by dispatching:
 *
 *   window.dispatchEvent(new CustomEvent('jarvis:open-session', {
 *     detail: { taskId },
 *   }));
 *
 * Distinct from the Answer HUD (which is a separate floating window
 * mostly meant for one-shot prompt → answer flows) and the
 * Observatory's TaskDetail (which is full-screen with a side
 * timeline). The Sidebar is the "peek without losing my place"
 * surface — Inbox row's TaskBindingBadge, an Activity row, the
 * tray's "running tasks" menu, anywhere — can all route to it.
 *
 * Closing it returns the user to the exact tab + scroll position
 * they had. The main app context never moves.
 */
export function SessionSidebar() {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Global event channel — anywhere in the app can dispatch this to
  // peek at a session. Idempotent: dispatching with the same taskId
  // while open just re-focuses the panel.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const detail = (e as CustomEvent).detail as { taskId?: string } | undefined;
      if (detail && typeof detail.taskId === 'string') setTaskId(detail.taskId);
    };
    window.addEventListener('jarvis:open-session', onOpen);
    return () => window.removeEventListener('jarvis:open-session', onOpen);
  }, []);

  // Esc closes — standard expectation.
  useEffect(() => {
    if (!taskId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setTaskId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [taskId]);

  // Fetch + subscribe whenever the tracked task id changes.
  useEffect(() => {
    if (!taskId) {
      setTask(null);
      setEvents([]);
      return;
    }
    let cancelled = false;
    void window.jarvis.listTasks().then((tasks) => {
      if (cancelled) return;
      const found = tasks.find((t) => t.id === taskId);
      setTask(found ?? null);
    });
    void window.jarvis.getTaskHistory(taskId).then((evts) => {
      if (cancelled) return;
      setEvents(evts);
    });
    const offStatus = window.jarvis.onTaskStatus((summary) => {
      if (summary.id === taskId) setTask(summary);
    });
    const offEvent = window.jarvis.onTaskEvent((payload) => {
      if (payload.taskId === taskId) {
        setEvents((prev) => [...prev, payload.event]);
      }
    });
    const offRemoved = window.jarvis.onTaskRemoved((id) => {
      if (id === taskId) setTaskId(null);
    });
    return () => {
      cancelled = true;
      offStatus();
      offEvent();
      offRemoved();
    };
  }, [taskId]);

  // Auto-scroll to the bottom as new events arrive so the latest
  // assistant message stays in view.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const summary = useMemo(() => composeTimeline(events), [events]);

  if (!taskId) return null;

  const openInObservatory = () => {
    void window.jarvis.openObservatory(taskId);
  };

  return (
    <div className="session-sidebar-host" aria-hidden={!taskId}>
      {/* Click outside the panel closes it. Doesn't navigate. */}
      <div
        className="session-sidebar-backdrop"
        onClick={() => setTaskId(null)}
        aria-label="Close session panel"
      />
      <aside
        className="session-sidebar"
        role="dialog"
        aria-label="Claude session"
      >
        <header className="session-sidebar__head">
          <div className="session-sidebar__head-text">
            <h3 title={task?.title ?? taskId}>
              {task?.title ?? 'Loading session…'}
            </h3>
            {task && (
              <div className="session-sidebar__meta">
                <span className={`session-sidebar__status session-sidebar__status--${task.status}`}>
                  {task.status}
                </span>
                {task.origin && (
                  <span className="session-sidebar__chip">{task.origin}</span>
                )}
                {task.skillId && (
                  <span className="session-sidebar__chip">{task.skillId}</span>
                )}
                {task.costUsd > 0 && (
                  <span className="session-sidebar__chip">
                    ${task.costUsd.toFixed(4)}
                  </span>
                )}
              </div>
            )}
          </div>
          <button
            className="session-sidebar__close"
            onClick={() => setTaskId(null)}
            aria-label="Close (Esc)"
            title="Close (Esc)"
          >
            ×
          </button>
        </header>

        <div className="session-sidebar__body" ref={bodyRef}>
          {events.length === 0 ? (
            <div className="session-sidebar__empty">
              No events yet — the session is just starting.
            </div>
          ) : (
            <>
              {summary.userPrompt && (
                <div className="session-sidebar__turn session-sidebar__turn--user">
                  <div className="session-sidebar__role">You</div>
                  <div className="session-sidebar__text">{summary.userPrompt}</div>
                </div>
              )}
              {summary.toolCount > 0 && (
                <div className="session-sidebar__tools">
                  {summary.toolCount} tool call{summary.toolCount === 1 ? '' : 's'}
                  {summary.lastTool ? ` · last: ${summary.lastTool}` : ''}
                </div>
              )}
              {summary.assistantText && (
                <div className="session-sidebar__turn session-sidebar__turn--assistant">
                  <div className="session-sidebar__role">Claude</div>
                  <MarkdownText>{summary.assistantText}</MarkdownText>
                </div>
              )}
              {summary.userReply && (
                <div className="session-sidebar__turn session-sidebar__turn--user">
                  <div className="session-sidebar__role">You · reply</div>
                  <div className="session-sidebar__text">{summary.userReply}</div>
                </div>
              )}
            </>
          )}
        </div>

        <footer className="session-sidebar__footer">
          <button
            className="session-sidebar__action"
            onClick={openInObservatory}
            title="Switch to the Observatory tab and focus this task (you'll leave the current view)"
          >
            Open full view →
          </button>
          {task?.sdkSessionId && (
            <button
              className="session-sidebar__action"
              onClick={() => {
                const cmd = `claude --resume ${task.sdkSessionId}`;
                void navigator.clipboard.writeText(cmd);
              }}
              title={`Copy: claude --resume ${task.sdkSessionId}`}
            >
              Copy resume cmd
            </button>
          )}
        </footer>
      </aside>
    </div>
  );
}

/**
 * Pull the most useful slice of the event stream for a peek-style
 * view: the original prompt, the latest assistant text, tool call
 * stats, and the last user reply if any. Skips the system-init noise
 * + thinking blocks. Mirrors AnswerHUD's composeAnswer but with a
 * different surface contract (transcript-ish, not just answer).
 */
function composeTimeline(events: TaskEvent[]): {
  userPrompt: string | null;
  userReply: string | null;
  assistantText: string;
  toolCount: number;
  lastTool: string | null;
} {
  let userPrompt: string | null = null;
  let userReply: string | null = null;
  let assistantText = '';
  let toolCount = 0;
  let lastTool: string | null = null;

  // Index user messages so we can split first (prompt) vs latest (reply).
  const userIdxs: number[] = [];
  for (let i = 0; i < events.length; i++) {
    if ((events[i]?.msg as { type?: string })?.type === 'user') userIdxs.push(i);
  }

  const extractText = (msg: unknown): string => {
    const content = (msg as { message?: { content?: unknown } })?.message?.content;
    if (Array.isArray(content)) {
      return (content as Array<Record<string, unknown>>)
        .flatMap((b) =>
          b['type'] === 'text' && typeof b['text'] === 'string'
            ? [b['text'] as string]
            : [],
        )
        .join('\n')
        .trim();
    }
    if (typeof content === 'string') return content.trim();
    return '';
  };

  if (userIdxs.length > 0) {
    userPrompt = extractText(events[userIdxs[0]!]!.msg) || null;
    if (userIdxs.length >= 2) {
      userReply = extractText(events[userIdxs[userIdxs.length - 1]!]!.msg) || null;
    }
  }

  for (const evt of events) {
    const msg = evt.msg as { type?: string; message?: { content?: unknown } };
    if (msg?.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        // Latest assistant text replaces — we want the freshest answer.
        assistantText = block['text'] as string;
      } else if (block['type'] === 'tool_use') {
        toolCount += 1;
        if (typeof block['name'] === 'string') {
          lastTool = block['name'] as string;
        }
      }
    }
  }

  return { userPrompt, userReply, assistantText, toolCount, lastTool };
}
