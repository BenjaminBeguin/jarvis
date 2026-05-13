import { useEffect, useMemo, useRef, useState } from 'react';

import type { TaskEvent, TaskSummary } from '../../shared/types';
import { MarkdownText } from './MarkdownText';
import { formatRelative } from './TaskList';

interface Props {
  task: TaskSummary;
  /** Lets reply paths swap to a freshly-created task (e.g. fork resume). */
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

interface RenderedEvent {
  key: string;
  kind: 'text' | 'user' | 'tool_use' | 'tool_result' | 'result' | 'error' | 'system';
  label: string;
  body: string;
  /** Timestamp from the wire event, ms epoch. */
  ts: number;
}

function renderEvent(event: TaskEvent): RenderedEvent | null {
  const msg = event.msg as { type?: string } & Record<string, unknown>;
  if (!msg || typeof msg !== 'object') return null;
  const ts = event.ts;

  if (msg.type === 'assistant') {
    const content = (msg['message'] as { content?: unknown })?.content;
    if (Array.isArray(content)) {
      const text = content
        .filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text')
        .map((c) => c.text)
        .join('');
      const tools = content.filter(
        (c): c is { type: 'tool_use'; name: string; input: unknown } =>
          (c as { type?: string }).type === 'tool_use',
      );
      if (tools.length > 0) {
        return {
          key: `${event.seq}-tool`,
          kind: 'tool_use',
          label: `tool · ${tools.map((t) => t.name).join(', ')}`,
          body: tools
            .map((t) => `${t.name}\n${JSON.stringify(t.input, null, 2)}`)
            .join('\n\n'),
          ts,
        };
      }
      if (text) {
        return { key: `${event.seq}-text`, kind: 'text', label: 'assistant', body: text, ts };
      }
    }
    return null;
  }

  if (msg.type === 'user') {
    const content = (msg['message'] as { content?: unknown })?.content;
    if (Array.isArray(content)) {
      const results = content.filter(
        (c): c is { type: 'tool_result'; content: unknown; tool_use_id: string } =>
          (c as { type?: string }).type === 'tool_result',
      );
      if (results.length > 0) {
        return {
          key: `${event.seq}-result`,
          kind: 'tool_result',
          label: 'tool result',
          body: results
            .map((r) =>
              typeof r.content === 'string'
                ? r.content
                : JSON.stringify(r.content, null, 2),
            )
            .join('\n\n'),
          ts,
        };
      }
      // Plain user text — the shape claude-code-watch produces from a
      // queue-operation/enqueue line, and what the SDK emits when the
      // user types a free-form prompt.
      const text = content
        .filter((c): c is { type: 'text'; text: string } => (c as { type?: string }).type === 'text')
        .map((c) => c.text)
        .join('');
      if (text) {
        return { key: `${event.seq}-user`, kind: 'user', label: 'user', body: text, ts };
      }
    } else if (typeof content === 'string' && content) {
      // Some SDK message shapes inline the prompt as a plain string.
      return { key: `${event.seq}-user`, kind: 'user', label: 'user', body: content, ts };
    }
    return null;
  }

  if (msg.type === 'result') {
    // The full assistant text already streamed via 'assistant' events
    // earlier in the loop — the result message just terminates the turn
    // and carries the cost/duration metadata. Render that as a thin
    // footer line instead of repeating the body.
    const r = msg as { total_cost_usd?: number; duration_ms?: number };
    const dur = r.duration_ms ?? 0;
    const cost = r.total_cost_usd ?? 0;
    return {
      key: `${event.seq}-final`,
      kind: 'result',
      label: 'turn complete',
      body: `${dur}ms · $${cost.toFixed(4)}`,
      ts,
    };
  }

  if (msg.type === 'system') {
    // System events (init, api_retry, etc.) are diagnostic noise for the
    // typical user. Render them but tag with kind:'system' so the panel
    // can hide them behind a toggle.
    const m = msg as { subtype?: string };
    return {
      key: `${event.seq}-sys`,
      kind: 'system',
      label: m.subtype ? `system · ${m.subtype}` : 'system',
      body: JSON.stringify(msg, null, 2),
      ts,
    };
  }

  if (msg.type === 'jarvis_error') {
    return {
      key: `${event.seq}-err`,
      kind: 'error',
      label: msg['aborted'] ? 'aborted' : 'error',
      body: String(msg['error'] ?? ''),
      ts,
    };
  }

  return null;
}

export function TaskDetail({ task, onSelectTask }: Props) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setEvents([]);
    void window.jarvis.getTaskHistory(task.id).then((evts) => {
      if (!cancelled) setEvents(evts);
    });
    const off = window.jarvis.onTaskEvent(({ taskId, event }) => {
      if (taskId !== task.id) return;
      setEvents((prev) => {
        if (prev.some((e) => e.seq === event.seq)) return prev;
        return [...prev, event];
      });
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [task.id]);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [events.length]);

  const rendered = events.map(renderEvent).filter((e): e is RenderedEvent => e !== null);
  const isAwaiting = !!task.awaitingInput;
  const [showRaw, setShowRaw] = useState(false);
  const systemCount = useMemo(
    () => rendered.filter((e) => e.kind === 'system').length,
    [rendered],
  );
  const visible = useMemo(
    () => (showRaw ? rendered : rendered.filter((e) => e.kind !== 'system')),
    [rendered, showRaw],
  );

  return (
    <section className="detail">
      <header className="detail__header">
        <div className="detail__title">
          <h2>{task.title}</h2>
          <div className="meta" title={new Date(task.startedAt).toLocaleString()}>
            {task.status} · {task.origin} · started {formatRelative(task.startedAt)}
            {task.costUsd > 0 && ` · $${task.costUsd.toFixed(4)}`}
          </div>
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
            onClick={() => setShowRaw((v) => !v)}
          >
            {showRaw
              ? `Hide ${systemCount} system event${systemCount === 1 ? '' : 's'}`
              : `Show ${systemCount} system event${systemCount === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
      <div className="detail__body" ref={bodyRef}>
        {visible.length === 0 && (
          <div className="empty">Waiting for output…</div>
        )}
        {visible.map((e) => (
          <div
            key={e.key}
            className={`event ${
              e.kind === 'tool_use' || e.kind === 'tool_result'
                ? 'event--tool'
                : e.kind === 'result'
                ? 'event--result'
                : e.kind === 'error'
                ? 'event--error'
                : e.kind === 'user'
                ? 'event--user'
                : e.kind === 'system'
                ? 'event--system'
                : ''
            }`}
          >
            <div className="event__kind">
              <span>{e.label}</span>
              <span className="event__time" title={new Date(e.ts).toLocaleString()}>
                {formatTime(e.ts)}
              </span>
            </div>
            <div className="event__text">
              {e.kind === 'text' || e.kind === 'user' ? (
                <MarkdownText>{e.body}</MarkdownText>
              ) : (
                e.body
              )}
            </div>
          </div>
        ))}
      </div>
      {isAwaiting && task.origin === 'external' && (
        <ContinueExternal task={task} onForked={onSelectTask} />
      )}
      {isAwaiting && task.origin !== 'external' && <SendReply task={task} />}
    </section>
  );
}

/**
 * "Continue here": forks the external claude session into a Jarvis-owned
 * task with full history. After this, the user can chat back-and-forth
 * inside Jarvis instead of switching to their terminal. The original
 * terminal session stays untouched — forkSession gives the resumed
 * conversation a new session id so the JSONLs don't collide.
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
        placeholder="Continue this conversation in Jarvis. ⌘↵ to send."
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
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
        Forks this session into a Jarvis-owned task with the full history.
        The terminal session stays untouched.
      </div>
      <div className="detail__reply-actions">
        <button onClick={() => void send()} disabled={sending || !text.trim()}>
          {sending ? 'Forking…' : 'Continue here'}
        </button>
      </div>
    </div>
  );
}

function SendReply({ task }: { task: TaskSummary }) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    taRef.current?.focus();
  }, [task.id]);

  // Reset on task change.
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
        placeholder="Reply to keep the conversation going. ⌘↵ to send."
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          }
        }}
      />
      {error && <div className="detail__reply-hint" style={{ color: 'var(--bad)' }}>{error}</div>}
      <div className="detail__reply-actions">
        <button onClick={() => void send()} disabled={sending || !text.trim()}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
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

