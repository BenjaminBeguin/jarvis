import { useEffect, useMemo, useRef, useState } from 'react';

import type { TaskEvent, TaskSummary } from '../../shared/types';

interface Props {
  task: TaskSummary;
}

interface RenderedEvent {
  key: string;
  kind: 'text' | 'user' | 'tool_use' | 'tool_result' | 'result' | 'error' | 'system';
  label: string;
  body: string;
}

function renderEvent(event: TaskEvent): RenderedEvent | null {
  const msg = event.msg as { type?: string } & Record<string, unknown>;
  if (!msg || typeof msg !== 'object') return null;

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
        };
      }
      if (text) {
        return { key: `${event.seq}-text`, kind: 'text', label: 'assistant', body: text };
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
        return { key: `${event.seq}-user`, kind: 'user', label: 'user', body: text };
      }
    } else if (typeof content === 'string' && content) {
      // Some SDK message shapes inline the prompt as a plain string.
      return { key: `${event.seq}-user`, kind: 'user', label: 'user', body: content };
    }
    return null;
  }

  if (msg.type === 'result') {
    const r = msg as { result?: string; total_cost_usd?: number; duration_ms?: number };
    return {
      key: `${event.seq}-final`,
      kind: 'result',
      label: 'result',
      body: [
        r.result ?? '',
        `\n— ${r.duration_ms ?? 0}ms · $${(r.total_cost_usd ?? 0).toFixed(4)}`,
      ].join(''),
    };
  }

  if (msg.type === 'system') {
    return {
      key: `${event.seq}-sys`,
      kind: 'system',
      label: 'system',
      body: JSON.stringify(msg, null, 2),
    };
  }

  if (msg.type === 'jarvis_error') {
    return {
      key: `${event.seq}-err`,
      kind: 'error',
      label: msg['aborted'] ? 'aborted' : 'error',
      body: String(msg['error'] ?? ''),
    };
  }

  return null;
}

export function TaskDetail({ task }: Props) {
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

  return (
    <section className="detail">
      <header className="detail__header">
        <div className="detail__title">
          <h2>{task.title}</h2>
          <div className="meta">
            {task.status} · {task.origin} · {new Date(task.startedAt).toLocaleString()}
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
      <div className="detail__body" ref={bodyRef}>
        {rendered.length === 0 && (
          <div className="empty">Waiting for output…</div>
        )}
        {rendered.map((e) => (
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
                : ''
            }`}
          >
            <div className="event__kind">{e.label}</div>
            <div className="event__text">{e.body}</div>
          </div>
        ))}
      </div>
      {isAwaiting && task.origin === 'external' && <QuickReply task={task} />}
    </section>
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

function QuickReply({ task }: { task: TaskSummary }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) taRef.current?.focus();
  }, [open]);

  // Reset when the selected task changes.
  useEffect(() => {
    setOpen(false);
    setText('');
    setCopied(false);
  }, [task.id]);

  const send = async () => {
    const value = text.trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setOpen(false);
        setText('');
      }, 1100);
    } catch {
      // No clipboard access (very rare in Electron); leave text in box.
    }
  };

  if (!open) {
    return (
      <div className="detail__reply-dock">
        <button className="detail__reply-open" onClick={() => setOpen(true)}>
          ✎ Compose reply → clipboard
        </button>
      </div>
    );
  }

  return (
    <div className="detail__reply-dock detail__reply-dock--open">
      <textarea
        ref={taRef}
        value={text}
        rows={3}
        placeholder="Type your reply. ⌘↵ to copy to clipboard."
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void send();
          } else if (e.key === 'Escape') {
            setOpen(false);
            setText('');
          }
        }}
      />
      <div className="detail__reply-actions">
        <button
          onClick={() => {
            setOpen(false);
            setText('');
          }}
        >
          Cancel
        </button>
        <button onClick={() => void send()} disabled={!text.trim()}>
          {copied ? '✓ Copied' : 'Copy to clipboard'}
        </button>
      </div>
      <div className="detail__reply-hint">
        Paste into the Claude Code terminal that owns this session — Jarvis
        can't write into a running process directly.
      </div>
    </div>
  );
}
