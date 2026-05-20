import { useEffect, useMemo, useRef, useState } from 'react';

import type { TaskEvent, TaskSummary } from '../../../shared/types';
import { buildItems } from '../../conversation/buildItems';
import type { ChatItem, ConversationMode } from '../../conversation/types';
import { MarkdownText } from '../MarkdownText';
import { formatRelative } from '../TaskList';
import { toast } from '../Toaster';

/**
 * Unified task-conversation surface. One component renders every
 * conversation in the app — sidebar slide-in, Observatory panel,
 * standalone Task page — so the user sees the same affordances
 * regardless of where the transcript lives.
 *
 * Chrome (always rendered when a task is loaded):
 *   - Header: title + status + origin + cost + cwd + session id row
 *     with "Copy resume" / "Open in Claude Code" / "Hand off to
 *     terminal" actions.
 *   - "Agent is waiting for your input" banner when applicable.
 *   - Composer at the bottom — SendReply for owned tasks, the
 *     fork-into-Jarvis ContinueExternal for external sessions.
 *   - Stop button while running.
 *
 * Transcript:
 *   - `mode='cozy'` (default): chat-bubble style. Tools collapse
 *     to one line (errors auto-expanded). System events render as
 *     a dim "thinking…" row.
 *   - `mode='full'`: tools + system events expanded by default,
 *     with a togglable "N system events" row at the top.
 */

interface Props {
  taskId: string;
  mode?: ConversationMode;
  /** Lets reply paths swap to a freshly-created task (e.g. fork
   *  resume from an external Claude Code session). */
  onSelectTask?: (id: string) => void;
}

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

function formatCwd(cwd: string): string {
  const match = cwd.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (match) return `~${match[1] ?? ''}`;
  return cwd;
}

/**
 * Strip the trailing prompt off task.title so the header reads as
 * a conversation name. deriveTitle in the runner builds the title
 * as "<skillName> · <first line of prompt>" — once the full
 * prompt also lands in the transcript as the first user message,
 * the trailing half just bloats the header. Show the prefix
 * (typically the skill name) and fall back to a 40-char clip
 * when there's no separator.
 */
function shortConversationName(task: TaskSummary): string {
  const t = task.title.trim();
  // Skip the resume-fork glyph if present.
  const stripped = t.startsWith('↪ ') ? t.slice(2) : t;
  const dot = stripped.indexOf(' · ');
  if (dot > 0) return stripped.slice(0, dot);
  return stripped.length > 40 ? stripped.slice(0, 39) + '…' : stripped;
}

export function Conversation({ taskId, mode = 'cozy', onSelectTask }: Props) {
  const [task, setTask] = useState<TaskSummary | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [showSystem, setShowSystem] = useState(mode === 'full');

  // Subscribe to TaskSummary so the header / awaiting badge / composer
  // react to status changes live.
  useEffect(() => {
    let cancelled = false;
    void window.jarvis.listTasks().then((all) => {
      if (cancelled) return;
      const t = all.find((x) => x.id === taskId);
      if (t) setTask(t);
    });
    const off = window.jarvis.onTaskStatus((summary) => {
      if (summary.id !== taskId) return;
      setTask(summary);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [taskId]);

  // Backfill history + subscribe to live events.
  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    void window.jarvis.getTaskHistory(taskId).then((history) => {
      if (cancelled) return;
      setEvents(history);
    });
    const off = window.jarvis.onTaskEvent(({ taskId: id, event }) => {
      if (id !== taskId) return;
      setEvents((prev) => {
        if (prev.some((e) => e.seq === event.seq)) return prev;
        return [...prev, event];
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [taskId]);

  const items = useMemo(() => buildItems(events), [events]);
  const systemCount = useMemo(
    () => items.filter((i) => i.kind === 'thinking').length,
    [items],
  );
  // Cozy default hides system events; full default shows them. Users
  // can toggle either way via the filter bar.
  const visible = useMemo(() => {
    if (showSystem) return items;
    return items.filter((i) => i.kind !== 'thinking');
  }, [items, showSystem]);

  // Scroll tracking: when the user scrolls up, stop auto-scrolling
  // until they come back to within 64px of the bottom.
  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const onScroll = (): void => {
      const dist = body.scrollHeight - body.scrollTop - body.clientHeight;
      stickToBottomRef.current = dist < 64;
    };
    body.addEventListener('scroll', onScroll, { passive: true });
    return () => body.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = body.scrollHeight;
  }, [visible.length]);

  if (!task) {
    return (
      <section className="detail">
        <div className="empty" style={{ padding: 24 }}>
          Loading conversation…
        </div>
      </section>
    );
  }

  // Defensive: a task in a terminal state can't actually be waiting
  // even if the awaitingInput flag is stale.
  const isAwaiting =
    !!task.awaitingInput &&
    task.status !== 'completed' &&
    task.status !== 'errored' &&
    task.status !== 'aborted';

  // The runner's sendMessage handles both live and completed cases:
  //   - running + queue open → push next user message
  //   - completed + sdkSessionId → spin up a fresh resume turn
  // So the composer should show whenever either path is viable, not
  // just when awaitingInput is set. Without this, a turn that ended
  // with the agent asking a question (but transitioned to completed)
  // would lock the user out of replying.
  const canResumeReply =
    task.status === 'completed' &&
    !!task.sdkSessionId &&
    task.origin !== 'external';
  const showComposer =
    task.origin !== 'external' && (isAwaiting || canResumeReply);

  return (
    <section className="detail">
      <header className="detail__header">
        <div className="detail__title">
          {/* Header shows the conversation name (skill / short
            * label). The full launching prompt now lands as the
            * first user message in the transcript, so duplicating
            * it here would just bloat the header. */}
          <h2 title={task.title}>{shortConversationName(task)}</h2>
          <div
            className="meta"
            title={new Date(task.startedAt).toLocaleString()}
          >
            {/* Match the wording used in TaskBindingBadge + the
              * Inbox awaiting strip so the same conversational
              * state reads the same everywhere. */}
            {(task.status === 'running' && task.awaitingInput) ||
            canResumeReply
              ? 'awaiting reply'
              : task.status}{' '}
            · {task.origin} · started {formatRelative(task.startedAt)}
            {task.costUsd > 0 && ` · $${task.costUsd.toFixed(4)}`}
            {task.pooled && (
              <span
                className="detail__pooled"
                title="This task resumed a pooled SDK session — skipped the cold-start cost. The session is shared with prior turns of the same skill within the 60-min pool window."
              >
                {' '}
                · ↪ pooled
              </span>
            )}
          </div>
          {task.cwd && task.origin !== 'external' && (
            <div className="meta detail__cwd" title="Working directory">
              📁 {formatCwd(task.cwd)}
            </div>
          )}
          {task.sdkSessionId && task.origin !== 'external' && (
            <SessionAffordances task={task} />
          )}
        </div>
        {task.status === 'running' && task.origin !== 'external' && (
          <button onClick={() => void window.jarvis.abortTask(task.id)}>
            Stop
          </button>
        )}
      </header>

      {isAwaiting && <AwaitingBanner />}

      {systemCount > 0 && (
        <div className="detail__filter-bar">
          <button
            className="detail__filter-toggle"
            onClick={() => setShowSystem((s) => !s)}
            title={
              showSystem ? 'Hide system diagnostics' : 'Show system diagnostics'
            }
          >
            {showSystem ? '▾' : '▸'} {systemCount} system event
            {systemCount === 1 ? '' : 's'}
          </button>
        </div>
      )}

      <div className="detail__body" ref={bodyRef}>
        {visible.length === 0 && (
          <div className="empty">
            {mode === 'cozy'
              ? 'Waiting for the agent to respond…'
              : 'No events yet.'}
          </div>
        )}
        {visible.map((item) => (
          <ChatItemRow key={item.key} item={item} mode={mode} />
        ))}
        {/* While the agent is processing (running, not waiting on
          * us), show a small heartbeat so the user knows their
          * reply was received and the model is working. Without
          * this the transcript just sits silent and the user
          * wonders if the send did anything. */}
        {task.status === 'running' && !task.awaitingInput && (
          <div className="detail__thinking">
            <span className="detail__thinking-dot" aria-hidden />
            <span>Agent is working…</span>
          </div>
        )}
      </div>

      {isAwaiting && task.origin === 'external' && (
        <ContinueExternal task={task} onForked={onSelectTask} />
      )}
      {showComposer && <SendReply task={task} resuming={canResumeReply} />}
    </section>
  );
}

function ChatItemRow({
  item,
  mode,
}: {
  item: ChatItem;
  mode: ConversationMode;
}) {
  if (item.kind === 'user') {
    return (
      <div className="chat-row chat-row--user">
        <span className="chat-row__chip">you</span>
        <div className="chat-row__body">
          <MarkdownText>{item.text}</MarkdownText>
        </div>
        <div
          className="chat-row__time"
          title={new Date(item.ts).toLocaleString()}
        >
          {formatTime(item.ts)}
        </div>
      </div>
    );
  }

  if (item.kind === 'assistant') {
    return (
      <div className="chat-row chat-row--assistant">
        <div className="chat-row__body">
          <MarkdownText>{item.text}</MarkdownText>
        </div>
        <div
          className="chat-row__time"
          title={new Date(item.ts).toLocaleString()}
        >
          {formatTime(item.ts)}
        </div>
      </div>
    );
  }

  if (item.kind === 'tool') {
    return <ToolRow item={item} mode={mode} />;
  }

  if (item.kind === 'thinking') {
    return <ThinkingRow item={item} mode={mode} />;
  }

  if (item.kind === 'result') {
    // Cozy view (sidebar / chat popup) hides turn boundaries — the
    // chat reads as one continuous thread the way chat apps do.
    // Full mode keeps them visible for cost / duration tracking.
    if (mode === 'cozy') return null;
    const dur =
      item.durationMs >= 60_000
        ? `${(item.durationMs / 1000 / 60).toFixed(1)}m`
        : item.durationMs >= 1000
          ? `${(item.durationMs / 1000).toFixed(1)}s`
          : `${item.durationMs}ms`;
    const cost = item.costUsd > 0 ? ` · $${item.costUsd.toFixed(4)}` : '';
    return (
      <div className="chat-row chat-row--result">
        ↪ turn · {dur}
        {cost}
      </div>
    );
  }

  if (item.kind === 'error') {
    return (
      <div className="chat-row chat-row--error">
        <span className="chat-row__chip chat-row__chip--error">
          {item.aborted ? 'aborted' : 'error'}
        </span>
        <div className="chat-row__body">{item.body}</div>
      </div>
    );
  }

  return null;
}

function ToolRow({
  item,
  mode,
}: {
  item: Extract<ChatItem, { kind: 'tool' }>;
  mode: ConversationMode;
}) {
  const [open, setOpen] = useState<boolean>(mode === 'full' || item.isError);
  const summary = item.preview ?? '';
  return (
    <div
      className={`chat-row chat-row--tool${item.isError ? ' chat-row--tool-error' : ''}`}
    >
      <button
        type="button"
        className="chat-row__tool-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="chat-row__tool-caret">{open ? '▾' : '▸'}</span>
        <span className="chat-row__tool-name">
          {item.isError ? '✗' : '⚙'} {item.name}
        </span>
        {summary && <span className="chat-row__tool-summary">{summary}</span>}
      </button>
      {open && (
        <div className="chat-row__tool-detail">
          {item.input !== null && item.input !== undefined && (
            <>
              <div className="chat-row__tool-label">Input</div>
              <pre className="chat-row__tool-pre">
                {typeof item.input === 'string'
                  ? item.input
                  : JSON.stringify(item.input, null, 2)}
              </pre>
            </>
          )}
          {item.result && (
            <>
              <div className="chat-row__tool-label">
                {item.isError ? 'Error' : 'Result'}
              </div>
              <pre
                className={`chat-row__tool-pre${item.isError ? ' chat-row__tool-pre--error' : ''}`}
              >
                {item.result}
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ThinkingRow({
  item,
  mode,
}: {
  item: Extract<ChatItem, { kind: 'thinking' }>;
  mode: ConversationMode;
}) {
  const [open, setOpen] = useState<boolean>(mode === 'full');
  return (
    <div className="chat-row chat-row--system">
      <button
        className="chat-row__tool-head"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="chat-row__tool-caret">{open ? '▾' : '▸'}</span>
        <span className="chat-row__tool-name">
          ✦{' '}
          {item.subtype === 'system' ? 'thinking…' : `${item.subtype}…`}
        </span>
      </button>
      {open && <pre className="chat-row__tool-pre">{item.body}</pre>}
    </div>
  );
}

function AwaitingBanner() {
  return (
    <div className="detail__awaiting">
      <span className="detail__awaiting-glyph">!</span>
      <span>Agent is waiting for your input</span>
    </div>
  );
}

function SendReply({
  task,
  resuming,
}: {
  task: TaskSummary;
  /** True when the task already finished and we'll be respawning a
   *  resume turn on the saved sdkSessionId rather than appending to
   *  a live queue. Surfaced as a hint under the textarea so the
   *  user knows the agent is going to wake back up. */
  resuming: boolean;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    taRef.current?.focus();
  }, [task.id]);

  useEffect(() => {
    setText('');
    setError(null);
  }, [task.id]);

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    setSending(true);
    setError(null);
    try {
      // The runner's sendMessage handles both paths — live queue
      // append or resume-then-fresh-turn — so the renderer just
      // calls one IPC.
      const ok = await window.jarvis.sendTaskMessage(task.id, value);
      if (!ok) {
        setError("Couldn't send — task isn't accepting input anymore.");
        return;
      }
      setText('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="detail__reply-dock detail__reply-dock--open">
      <textarea
        ref={taRef}
        value={text}
        rows={3}
        placeholder={
          resuming
            ? 'Continue this conversation. ↵ to send, ⇧↵ for newline.'
            : 'Reply to keep the conversation going. ↵ to send, ⇧↵ for newline.'
        }
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (
            e.key === 'Enter' &&
            !e.shiftKey &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey
          ) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {resuming && !error && (
        <div className="detail__reply-hint">
          Turn complete — your reply will resume the session and start
          a new turn.
        </div>
      )}
      {error && (
        <div className="detail__reply-hint" style={{ color: 'var(--bad)' }}>
          {error}
        </div>
      )}
      <div className="detail__reply-actions">
        <button onClick={() => void send()} disabled={sending || !text.trim()}>
          {sending ? 'Sending…' : resuming ? 'Continue' : 'Send'}
        </button>
      </div>
    </div>
  );
}

/**
 * Fork an external Claude Code session into a Jarvis-owned task with
 * the full history. Lets the user keep chatting inside Jarvis instead
 * of switching to their terminal — the original session stays
 * untouched (the fork gets a new SDK session id).
 */
function ContinueExternal({
  task,
  onForked,
}: {
  task: TaskSummary;
  onForked?: (newId: string) => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    taRef.current?.focus();
  }, [task.id]);

  useEffect(() => {
    setText('');
    setError(null);
  }, [task.id]);

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    if (!task.id.startsWith('cc-')) {
      setError('Cannot resume this task — unknown source format.');
      return;
    }
    const sessionId = task.id.slice('cc-'.length);
    setSending(true);
    setError(null);
    try {
      const summary = await window.jarvis.launchTask({
        prompt: value,
        origin: 'palette',
        resumeSessionId: sessionId,
      });
      setText('');
      onForked?.(summary.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="detail__reply-dock detail__reply-dock--open">
      <textarea
        ref={taRef}
        value={text}
        rows={3}
        placeholder="Continue this conversation in Jarvis. ↵ to send, ⇧↵ for newline."
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (
            e.key === 'Enter' &&
            !e.shiftKey &&
            !e.metaKey &&
            !e.ctrlKey &&
            !e.altKey
          ) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {error && (
        <div className="detail__reply-hint" style={{ color: 'var(--bad)' }}>
          {error}
        </div>
      )}
      <div className="detail__reply-hint">
        Forks this session into a Jarvis-owned task with the full
        history. The terminal session stays untouched.
      </div>
      <div className="detail__reply-actions">
        <button onClick={() => void send()} disabled={sending || !text.trim()}>
          {sending ? 'Forking…' : 'Continue here'}
        </button>
      </div>
    </div>
  );
}

/**
 * Inline footer that lets the user jump from a Jarvis task into the
 * same conversation in Claude Code (CLI or Desktop).
 */
function SessionAffordances({ task }: { task: TaskSummary }) {
  if (!task.sdkSessionId) return null;
  const sessionId = task.sdkSessionId;
  const resumeCmd = `claude --resume ${sessionId}`;
  const isLive = task.status === 'running' || task.status === 'queued';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(resumeCmd);
      toast({ message: 'Copied — paste in any terminal to resume' });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const openInDesktop = async () => {
    if (isLive) {
      const ok = confirm(
        'This task is still running in Jarvis. Opening it in Claude Code Desktop ' +
          "while it's live can corrupt the session. Open anyway?",
      );
      if (!ok) return;
    }
    let copied = false;
    try {
      await navigator.clipboard.writeText(resumeCmd);
      copied = true;
    } catch {
      // clipboard can fail in some webview contexts; we'll still open Claude
    }
    const res = await window.jarvis.openInClaudeDesktop(sessionId);
    if (res.ok) {
      toast({
        message: copied
          ? `Claude opened · ${resumeCmd.slice(0, 36)}… copied — paste it to resume`
          : 'Claude opened — session is in Recents (couldn’t copy resume cmd)',
      });
    } else {
      toast({
        kind: 'error',
        message: res.message ?? 'Failed to open Claude Code Desktop',
      });
    }
  };

  const handOff = async () => {
    try {
      await window.jarvis.abortTask(task.id);
      await navigator.clipboard.writeText(resumeCmd);
      toast({
        message: `Aborted in Jarvis · ${resumeCmd} copied. Paste in any terminal to continue.`,
      });
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div className="detail__session-row" title={`session ${sessionId}`}>
      <code className="detail__session-id">{sessionId.slice(0, 8)}…</code>
      <button
        onClick={() => void copy()}
        title={`Copy "${resumeCmd}" to clipboard`}
      >
        Copy resume command
      </button>
      <button
        onClick={() => void openInDesktop()}
        title="Open this session in Claude Code Desktop"
      >
        Open in Claude Code
      </button>
      {isLive && (
        <button
          onClick={() => void handOff()}
          title="Stop Jarvis cleanly and copy the resume command so you can continue in a terminal"
          className="detail__session-handoff"
        >
          Hand off to terminal
        </button>
      )}
    </div>
  );
}
