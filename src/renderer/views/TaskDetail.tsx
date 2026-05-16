import { useEffect, useMemo, useRef, useState } from 'react';

import type { TaskEvent, TaskSummary } from '../../shared/types';
import { MarkdownText } from './MarkdownText';
import { formatRelative } from './TaskList';
import { toast } from './Toaster';

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

/** Collapse the user's home directory to `~` for compact display. */
function formatCwd(cwd: string): string {
  // The renderer doesn't know HOMEDIR; sniff it from the path. Most macOS
  // homes live under /Users/, so trim the first two segments and prefix `~`.
  const match = cwd.match(/^\/Users\/[^/]+(\/.*)?$/);
  if (match) return `~${match[1] ?? ''}`;
  return cwd;
}

/**
 * One renderable item in the chat timeline. Tool calls are paired with
 * their matching tool_result by tool_use_id so the UI can render them as
 * a single collapsible row (Claude Code-style) instead of two unrelated
 * blocks far apart in the transcript.
 */
type ChatItem =
  | { kind: 'assistant'; key: string; ts: number; text: string }
  | { kind: 'user'; key: string; ts: number; text: string }
  | {
      kind: 'tool';
      key: string;
      ts: number;
      name: string;
      input: unknown;
      result: string | null;
      isError: boolean;
    }
  | { kind: 'system'; key: string; ts: number; subtype: string; body: string }
  | { kind: 'result'; key: string; ts: number; durationMs: number; costUsd: number }
  | { kind: 'error'; key: string; ts: number; body: string; aborted: boolean };

function toolResultBody(content: unknown): { text: string; isError: boolean } {
  // tool_result content shape: string OR array of {type:'text', text} blocks,
  // sometimes carrying an is_error flag at the block or parent level.
  if (typeof content === 'string') return { text: content, isError: false };
  if (Array.isArray(content)) {
    const parts = (content as Array<Record<string, unknown>>).map((b) =>
      b['type'] === 'text' && typeof b['text'] === 'string'
        ? (b['text'] as string)
        : JSON.stringify(b),
    );
    return { text: parts.join('\n'), isError: false };
  }
  return { text: JSON.stringify(content, null, 2), isError: false };
}

function buildChatTimeline(events: TaskEvent[]): ChatItem[] {
  const items: ChatItem[] = [];
  const toolIndexById = new Map<string, number>();

  for (const event of events) {
    const msg = event.msg as
      | ({ type?: string } & Record<string, unknown>)
      | undefined;
    if (!msg || typeof msg !== 'object') continue;
    const ts = event.ts;

    if (msg.type === 'assistant') {
      const content = (msg['message'] as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          const text = (block['text'] as string).trim();
          if (text) {
            items.push({
              kind: 'assistant',
              key: `${event.seq}-a-${items.length}`,
              ts,
              text,
            });
          }
        } else if (
          block['type'] === 'tool_use' &&
          typeof block['name'] === 'string'
        ) {
          const id =
            typeof block['id'] === 'string' ? (block['id'] as string) : null;
          const idx = items.length;
          items.push({
            kind: 'tool',
            key: `${event.seq}-t-${idx}`,
            ts,
            name: block['name'] as string,
            input: block['input'],
            result: null,
            isError: false,
          });
          if (id) toolIndexById.set(id, idx);
        }
      }
      continue;
    }

    if (msg.type === 'user') {
      const content = (msg['message'] as { content?: unknown })?.content;
      if (Array.isArray(content)) {
        // Tool results land as user messages — fold them into the matching
        // tool entry so they share one collapsible row.
        let consumedAsResult = false;
        for (const block of content as Array<Record<string, unknown>>) {
          if (block['type'] === 'tool_result') {
            const id =
              typeof block['tool_use_id'] === 'string'
                ? (block['tool_use_id'] as string)
                : null;
            const { text } = toolResultBody(block['content']);
            const isError = block['is_error'] === true;
            if (id && toolIndexById.has(id)) {
              const idx = toolIndexById.get(id)!;
              const tool = items[idx] as ChatItem & { kind: 'tool' };
              tool.result = text;
              tool.isError = isError || tool.isError;
              consumedAsResult = true;
            } else {
              // Orphan result — render as its own tool row with no name.
              items.push({
                kind: 'tool',
                key: `${event.seq}-r-${items.length}`,
                ts,
                name: 'result',
                input: null,
                result: text,
                isError,
              });
              consumedAsResult = true;
            }
          }
        }
        if (consumedAsResult) continue;
        // Plain user text.
        const text = (content as Array<Record<string, unknown>>)
          .filter(
            (b) => b['type'] === 'text' && typeof b['text'] === 'string',
          )
          .map((b) => b['text'] as string)
          .join('')
          .trim();
        if (text) {
          items.push({
            kind: 'user',
            key: `${event.seq}-u`,
            ts,
            text,
          });
        }
        continue;
      }
      if (typeof content === 'string' && content.trim()) {
        items.push({
          kind: 'user',
          key: `${event.seq}-u`,
          ts,
          text: content.trim(),
        });
      }
      continue;
    }

    if (msg.type === 'result') {
      const r = msg as { total_cost_usd?: number; duration_ms?: number };
      items.push({
        kind: 'result',
        key: `${event.seq}-final`,
        ts,
        durationMs: r.duration_ms ?? 0,
        costUsd: r.total_cost_usd ?? 0,
      });
      continue;
    }

    if (msg.type === 'system') {
      const m = msg as { subtype?: string };
      items.push({
        kind: 'system',
        key: `${event.seq}-sys`,
        ts,
        subtype: m.subtype ?? 'system',
        body: JSON.stringify(msg, null, 2),
      });
      continue;
    }

    if (msg.type === 'jarvis_error') {
      items.push({
        kind: 'error',
        key: `${event.seq}-err`,
        ts,
        body: String(msg['error'] ?? ''),
        aborted: !!msg['aborted'],
      });
      continue;
    }
  }

  return items;
}

/**
 * Build a one-line preview of a tool call from its input object — picks
 * the first identifying arg (path, command, url, query…). Keeps the
 * collapsed row compact while still showing what the tool is touching.
 */
function toolPreview(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  for (const key of [
    'file_path',
    'path',
    'filename',
    'command',
    'url',
    'query',
    'pattern',
    'description',
    'prompt',
  ]) {
    const v = i[key];
    if (typeof v === 'string' && v.trim()) {
      const compact = v.length > 90 ? v.slice(0, 90) + '…' : v;
      return compact.replace(/\n/g, ' ');
    }
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

  const items = useMemo(() => buildChatTimeline(events), [events]);
  // Defensive: a task in a terminal state can't actually be waiting for
  // input even if the awaitingInput flag is stale. Belt-and-suspenders
  // alongside the main-side fix in updateExternalStatus.
  const isAwaiting =
    !!task.awaitingInput &&
    task.status !== 'completed' &&
    task.status !== 'errored' &&
    task.status !== 'aborted';
  // Show diagnostic 'system' events (init, api_retry, …) behind a toggle.
  // Default off — they're never what the user wants to read first.
  const [showSystem, setShowSystem] = useState(false);
  const systemCount = useMemo(
    () => items.filter((i) => i.kind === 'system').length,
    [items],
  );
  const visible = useMemo(
    () => (showSystem ? items : items.filter((i) => i.kind !== 'system')),
    [items, showSystem],
  );

  return (
    <section className="detail">
      <header className="detail__header">
        <div className="detail__title">
          <h2>{task.title}</h2>
          <div className="meta" title={new Date(task.startedAt).toLocaleString()}>
            {task.status} · {task.origin} · started {formatRelative(task.startedAt)}
            {task.costUsd > 0 && ` · $${task.costUsd.toFixed(4)}`}
            {task.pooled && (
              <span
                className="detail__pooled"
                title="This task resumed a pooled SDK session — skipped the cold-start cost (system prompt + skill body + tool inventory). The session is shared with prior turns of the same skill within the 60-min pool window."
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
            title={showSystem ? 'Hide system diagnostics' : 'Show system diagnostics'}
          >
            {showSystem ? '▾' : '▸'} {systemCount} system event
            {systemCount === 1 ? '' : 's'}
          </button>
        </div>
      )}
      <div className="detail__body" ref={bodyRef}>
        {visible.length === 0 && <div className="empty">Waiting for output…</div>}
        {visible.map((it) => (
          <ChatRow key={it.key} item={it} />
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
 * Single timeline row. Each kind renders very differently so the chat
 * reads like a conversation, not a uniform stream of cards. Tools are
 * collapsed to a one-line summary by default; click to expand input +
 * result. Assistant text gets no header (it IS the content); user
 * messages get a distinct "you" chip + sans-serif prose.
 */
function ChatRow({ item }: { item: ChatItem }) {
  const [expanded, setExpanded] = useState(false);

  if (item.kind === 'assistant') {
    return (
      <div className="chat-row chat-row--assistant">
        <div className="chat-row__body">
          <MarkdownText>{item.text}</MarkdownText>
        </div>
        <div className="chat-row__time" title={new Date(item.ts).toLocaleString()}>
          {formatTime(item.ts)}
        </div>
      </div>
    );
  }

  if (item.kind === 'user') {
    return (
      <div className="chat-row chat-row--user">
        <span className="chat-row__chip">you</span>
        <div className="chat-row__body">
          <MarkdownText>{item.text}</MarkdownText>
        </div>
        <div className="chat-row__time" title={new Date(item.ts).toLocaleString()}>
          {formatTime(item.ts)}
        </div>
      </div>
    );
  }

  if (item.kind === 'tool') {
    const preview = toolPreview(item.input);
    return (
      <div
        className={`chat-row chat-row--tool${item.isError ? ' chat-row--tool-error' : ''}${
          item.result === null ? ' chat-row--tool-pending' : ''
        }`}
      >
        <button
          className="chat-row__tool-head"
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Collapse' : 'Expand to see input + output'}
        >
          <span className="chat-row__tool-caret">{expanded ? '▾' : '▸'}</span>
          <span
            className={`chat-row__tool-dot${
              item.isError
                ? ' chat-row__tool-dot--error'
                : item.result === null
                  ? ' chat-row__tool-dot--pending'
                  : ''
            }`}
          />
          <span className="chat-row__tool-name">{item.name}</span>
          {preview && <span className="chat-row__tool-preview">{preview}</span>}
          {item.result === null && (
            <span className="chat-row__tool-status">running…</span>
          )}
        </button>
        {expanded && (
          <div className="chat-row__tool-body">
            {item.input !== null && item.input !== undefined && (
              <>
                <div className="chat-row__tool-label">input</div>
                <pre className="chat-row__tool-pre">
                  {JSON.stringify(item.input, null, 2)}
                </pre>
              </>
            )}
            {item.result !== null && (
              <>
                <div className="chat-row__tool-label">output</div>
                <pre className="chat-row__tool-pre">{item.result}</pre>
              </>
            )}
          </div>
        )}
      </div>
    );
  }

  if (item.kind === 'result') {
    return (
      <div className="chat-row chat-row--result">
        turn complete · {item.durationMs}ms · ${item.costUsd.toFixed(4)}
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

  // system — single dim diagnostic line, expandable
  return (
    <div className="chat-row chat-row--system">
      <button
        className="chat-row__tool-head"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="chat-row__tool-caret">{expanded ? '▾' : '▸'}</span>
        <span className="chat-row__tool-name">system · {item.subtype}</span>
      </button>
      {expanded && <pre className="chat-row__tool-pre">{item.body}</pre>}
    </div>
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
        placeholder="Continue this conversation in Jarvis. ↵ to send, ⇧↵ for newline."
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
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
        placeholder="Reply to keep the conversation going. ↵ to send, ⇧↵ for newline."
        disabled={sending}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
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

/**
 * Inline footer that lets the user jump from a Jarvis task into the same
 * conversation in Claude Code (CLI or Desktop). Subscription-mode tasks ARE
 * Claude Code sessions on disk — Desktop already lists them in Recents.
 */
function SessionAffordances({ task }: { task: TaskSummary }) {
  if (!task.sdkSessionId) return null;
  const sessionId = task.sdkSessionId;
  const resumeCmd = `claude --resume ${sessionId}`;
  // Pre-warn when the user might collide with Jarvis still writing. We don't
  // block the action — they may know what they're doing — but a confirm is
  // a cheap guard against the foot-gun of two writers on one session.
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
    // Claude Code Desktop has no deep-link scheme to resume a specific
    // session, so the best we can do is bring the app forward AND copy
    // the resume command — the user pastes it once Claude is open.
    let copied = false;
    try {
      await navigator.clipboard.writeText(resumeCmd);
      copied = true;
    } catch {
      // clipboard can fail in some webview contexts; we'll still open the app
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

  /**
   * The "I'll take it from here" path. Aborts Jarvis's iterator (so we
   * don't have two writers on the same session), copies the resume
   * command to clipboard, and tells the user where to paste it.
   * Visible only while the task is live.
   */
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
      <button onClick={() => void copy()} title={`Copy "${resumeCmd}" to clipboard`}>
        Copy resume command
      </button>
      <button onClick={() => void openInDesktop()} title="Open this session in Claude Code Desktop">
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

