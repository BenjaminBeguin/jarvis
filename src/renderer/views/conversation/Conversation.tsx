import { useEffect, useMemo, useRef, useState } from 'react';

import type { TaskEvent, TaskSummary } from '../../../shared/types';
import { buildItems } from '../../conversation/buildItems';
import type { ChatItem, ConversationMode } from '../../conversation/types';
import { AudioCapture } from '../../voice/AudioCapture';
import { MarkdownText } from '../MarkdownText';
import { formatRelative } from '../TaskList';
import { toast } from '../Toaster';

interface AttachedImage {
  mediaType: string;
  base64: string;
  /** data:URL kept on the client for the thumbnail preview. */
  dataUrl: string;
  /** Stable id for React keys — generated client-side. */
  id: string;
}

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
  /** Toggle: when on, each completed assistant turn is read aloud
   *  via macOS `say`. Reads the global "always read aloud"
   *  preference on mount + on changes from other windows, so
   *  flipping it in Settings (or in a sibling conversation) is
   *  reflected everywhere. Toggling the icon writes back to the
   *  global pref — the toggle is the source of truth. */
  const [speakReplies, setSpeakRepliesLocal] = useState(false);
  useEffect(() => {
    void window.jarvis.readVoiceAlwaysSpeak().then(setSpeakRepliesLocal);
    const off = window.jarvis.onVoiceAlwaysSpeakChanged(setSpeakRepliesLocal);
    return () => {
      off?.();
    };
  }, []);
  useEffect(() => {
    // Stop any in-flight TTS when switching conversations so we
    // don't keep talking about a thread the user already moved away
    // from. The preference itself stays.
    void window.jarvis.stopSpeaking();
  }, [taskId]);
  const setSpeakReplies = (next: boolean) => {
    setSpeakRepliesLocal(next);
    void window.jarvis.writeVoiceAlwaysSpeak(next);
  };
  /** Index of the most recently-spoken `result` item in the chat
   *  timeline. Used to identify which assistant text belongs to a
   *  fresh turn so we don't replay history. */
  const lastSpokenResultRef = useRef(-1);
  const speakRepliesRef = useRef(false);

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

  // Speak completed turns aloud when the toggle is on. We key off
  // 'result' events — that's the turn boundary, so the assistant
  // text between the previous and current result is what to read.
  useEffect(() => {
    const justEnabled = speakReplies && !speakRepliesRef.current;
    const justDisabled = !speakReplies && speakRepliesRef.current;
    speakRepliesRef.current = speakReplies;

    let latestResultIdx = -1;
    for (let i = 0; i < items.length; i++) {
      if (items[i]?.kind === 'result') latestResultIdx = i;
    }

    if (justDisabled) {
      void window.jarvis.stopSpeaking();
      return;
    }
    if (justEnabled) {
      // Don't replay the existing transcript — only speak turns
      // that finish AFTER the toggle was flipped on.
      lastSpokenResultRef.current = latestResultIdx;
      return;
    }
    if (!speakReplies) return;
    if (latestResultIdx <= lastSpokenResultRef.current) return;

    const start = lastSpokenResultRef.current + 1;
    const end = latestResultIdx;
    lastSpokenResultRef.current = latestResultIdx;

    const parts: string[] = [];
    for (let i = start; i < end; i++) {
      const it = items[i];
      if (it?.kind === 'assistant') parts.push(it.text);
    }
    const combined = parts.join(' ').trim();
    if (combined) void window.jarvis.speak(combined);
  }, [items, speakReplies]);

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

  // The runner's sendMessage handles three live cases:
  //   - running + queue open + awaitingInput → push next user message
  //   - running + queue open + agent mid-turn → push to the SAME queue;
  //     SDK consumes it on its next iteration (the user's "ping while
  //     working" path)
  //   - completed + sdkSessionId → spin up a fresh resume turn
  // The composer should be visible in all three cases. Without this,
  // the user thinks they can't interject while the agent is mid-flight
  // even though the runner happily queues their message for the next
  // turn.
  const canResumeReply =
    task.status === 'completed' &&
    !!task.sdkSessionId &&
    task.origin !== 'external';
  const canPingMidTurn =
    task.status === 'running' && !task.awaitingInput;
  const showComposer =
    task.origin !== 'external' &&
    (isAwaiting || canResumeReply || canPingMidTurn);

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
          <>
            <EscalateButton taskId={task.id} />
            <button onClick={() => void window.jarvis.abortTask(task.id)}>
              Stop
            </button>
          </>
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
      {showComposer && (
        <SendReply
          task={task}
          resuming={canResumeReply}
          midTurn={canPingMidTurn}
          speakReplies={speakReplies}
          onToggleSpeakReplies={() => setSpeakReplies(!speakReplies)}
        />
      )}
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
          {item.images && item.images.length > 0 && (
            <div className="chat-row__images">
              {item.images.map((img, i) => (
                <img
                  key={i}
                  src={img.dataUrl}
                  alt="Attachment"
                  className="chat-row__image"
                />
              ))}
            </div>
          )}
          {item.text && <MarkdownText>{item.text}</MarkdownText>}
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
  midTurn,
  speakReplies,
  onToggleSpeakReplies,
}: {
  task: TaskSummary;
  /** True when the task already finished and we'll be respawning a
   *  resume turn on the saved sdkSessionId rather than appending to
   *  a live queue. Surfaced as a hint under the textarea so the
   *  user knows the agent is going to wake back up. */
  resuming: boolean;
  /** True when the agent is currently mid-turn (running, not
   *  awaiting). The send STILL works — the runner queues into the
   *  same input stream and the SDK consumes on its next iteration —
   *  but the placeholder hints that there's a delay. */
  midTurn: boolean;
  /** Whether the agent's replies will be read aloud (macOS `say`). */
  speakReplies: boolean;
  onToggleSpeakReplies: () => void;
}) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<AttachedImage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const captureRef = useRef<AudioCapture | null>(null);

  useEffect(() => {
    taRef.current?.focus();
  }, [task.id]);

  useEffect(() => {
    setText('');
    setImages([]);
    setError(null);
  }, [task.id]);

  const send = async () => {
    const value = text.trim();
    if (!value && images.length === 0) return;
    setSending(true);
    setError(null);
    try {
      const payload = images.map((i) => ({
        mediaType: i.mediaType,
        base64: i.base64,
      }));
      const ok = await window.jarvis.sendTaskMessage(task.id, value, payload);
      if (!ok) {
        setError("Couldn't send — task isn't accepting input anymore.");
        return;
      }
      setText('');
      setImages([]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const onPickImages = (): void => {
    fileInputRef.current?.click();
  };

  const ingestFiles = async (files: FileList | File[] | null): Promise<void> => {
    if (!files) return;
    const list: File[] = Array.from(files).filter((f) =>
      f.type.startsWith('image/'),
    );
    if (list.length === 0) return;
    const added: AttachedImage[] = [];
    for (const file of list.slice(0, 8 - images.length)) {
      try {
        const base64 = await fileToBase64(file);
        added.push({
          id:
            typeof crypto !== 'undefined' && 'randomUUID' in crypto
              ? crypto.randomUUID()
              : String(Math.random()).slice(2),
          mediaType: file.type || 'image/png',
          base64,
          dataUrl: `data:${file.type || 'image/png'};base64,${base64}`,
        });
      } catch (e) {
        toast({
          kind: 'error',
          message: `Couldn't read ${file.name}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    }
    if (added.length > 0) {
      setImages((prev) => [...prev, ...added]);
    }
  };

  const onPaste = async (
    e: React.ClipboardEvent<HTMLTextAreaElement>,
  ): Promise<void> => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it && it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      await ingestFiles(files);
    }
  };

  const onDrop = async (
    e: React.DragEvent<HTMLDivElement>,
  ): Promise<void> => {
    e.preventDefault();
    await ingestFiles(e.dataTransfer.files);
  };

  /** Hold-to-talk: press starts the recorder, release stops + transcribes
   *  and appends to the textarea. Mirrors the palette's voice path. */
  const startListening = async (): Promise<void> => {
    if (listening || transcribing) return;
    // Suppress meeting-recorder BEFORE opening the mic — otherwise
    // coreaudiod's first "Input/Capture" log wins the race.
    await window.jarvis.noteSelfMicStart();
    const capture = new AudioCapture();
    try {
      await capture.start();
      captureRef.current = capture;
      setListening(true);
    } catch (e) {
      void window.jarvis.noteSelfMicStop();
      setError(
        `Mic access failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  };

  const stopListening = async (): Promise<void> => {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;
    setListening(false);
    void window.jarvis.noteSelfMicStop();
    setTranscribing(true);
    try {
      const result = await capture.stop();
      if (result.pcm.length < 16_000 * 0.3) {
        setError("Didn't hear anything — hold the mic while speaking.");
        return;
      }
      const raw = await window.jarvis.transcribe(
        result.pcm.buffer as ArrayBuffer,
      );
      const transcript = (raw ?? '').trim();
      if (!transcript) {
        setError(
          "Couldn't make out the audio. Try again with less background noise.",
        );
        return;
      }
      setText((prev) => (prev ? `${prev} ${transcript}` : transcript));
    } catch (e) {
      setError(
        `Transcribe failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setTranscribing(false);
    }
  };

  const removeImage = (id: string): void => {
    setImages((prev) => prev.filter((i) => i.id !== id));
  };

  const canSend = !sending && (text.trim().length > 0 || images.length > 0);

  return (
    <div
      className="detail__reply-dock detail__reply-dock--open"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => void onDrop(e)}
    >
      {images.length > 0 && (
        <div className="detail__reply-attachments">
          {images.map((img) => (
            <div key={img.id} className="detail__reply-attachment">
              <img src={img.dataUrl} alt="Attached" />
              <button
                type="button"
                className="detail__reply-attachment-remove"
                onClick={() => removeImage(img.id)}
                aria-label="Remove attachment"
                title="Remove"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <textarea
        ref={taRef}
        value={text}
        rows={3}
        placeholder={
          listening
            ? 'Listening… release the mic to transcribe.'
            : transcribing
              ? 'Transcribing…'
              : resuming
                ? 'Continue this conversation. ↵ to send, ⇧↵ for newline. Paste or drop images to attach.'
                : midTurn
                  ? 'Agent is working — your message queues for the next turn. ↵ to send.'
                  : 'Reply to keep the conversation going. ↵ to send, ⇧↵ for newline. Paste or drop images to attach.'
        }
        disabled={sending || transcribing}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => void onPaste(e)}
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
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          void ingestFiles(e.target.files);
          // Reset so picking the same file twice in a row still fires onChange.
          e.target.value = '';
        }}
      />
      {resuming && !error && (
        <div className="detail__reply-hint">
          Turn complete — your reply will resume the session and start
          a new turn.
        </div>
      )}
      {midTurn && !error && (
        <div className="detail__reply-hint">
          Agent is mid-turn. Your message will be picked up at the start
          of its next iteration — usually within a few seconds.
        </div>
      )}
      {error && (
        <div className="detail__reply-hint" style={{ color: 'var(--bad)' }}>
          {error}
        </div>
      )}
      <div className="detail__reply-actions">
        <button
          type="button"
          className="detail__reply-icon"
          onClick={onPickImages}
          disabled={sending || images.length >= 8}
          title={
            images.length >= 8
              ? '8-image cap reached'
              : 'Attach images (also: paste or drop)'
          }
          aria-label="Attach images"
        >
          📎
        </button>
        <button
          type="button"
          className={`detail__reply-icon${listening ? ' detail__reply-icon--listening' : ''}`}
          onPointerDown={() => void startListening()}
          onPointerUp={() => void stopListening()}
          onPointerLeave={() => {
            if (listening) void stopListening();
          }}
          disabled={sending || transcribing}
          title="Hold to talk — releases transcribes and inserts the text"
          aria-label="Hold to record voice"
        >
          🎙
        </button>
        <button
          type="button"
          className={`detail__reply-icon${speakReplies ? ' detail__reply-icon--on' : ''}`}
          onClick={onToggleSpeakReplies}
          disabled={sending}
          title={
            speakReplies
              ? 'Replies are being read aloud — click to silence'
              : 'Read each completed reply aloud'
          }
          aria-label="Toggle speak replies"
          aria-pressed={speakReplies}
        >
          {speakReplies ? '🔊' : '🔈'}
        </button>
        <div className="detail__reply-spacer" />
        <button onClick={() => void send()} disabled={!canSend}>
          {sending ? 'Sending…' : resuming ? 'Continue' : 'Send'}
        </button>
      </div>
    </div>
  );
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        reject(new Error('FileReader returned non-string result'));
        return;
      }
      // result is "data:image/png;base64,XXXX" — strip the prefix.
      const comma = result.indexOf(',');
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsDataURL(file);
  });
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
 * "↑ Escalate" button — bumps a running task to a higher model tier.
 * Aborts the current SDK query and resumes the same session on the
 * next tier up (haiku → sonnet → opus). The conversation continues
 * seamlessly; the user sees a system event in the transcript
 * marking the switch.
 *
 * Disabled while the request is in-flight to prevent double-clicks.
 * On error (e.g. "already on smart") shows a toast and stays
 * enabled.
 */
function EscalateButton({ taskId }: { taskId: string }) {
  const [busy, setBusy] = useState(false);

  const escalate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await window.jarvis.escalateTask({ taskId });
      if (result.ok) {
        toast({ message: result.message ?? 'Escalated.' });
      } else {
        toast({
          kind: 'error',
          message: result.message ?? "Couldn't escalate.",
        });
      }
    } catch (e) {
      toast({
        kind: 'error',
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <button
      className="detail__escalate"
      onClick={() => void escalate()}
      disabled={busy}
      title="Switch this task to a more capable model (one tier up). Same conversation, smarter agent."
    >
      {busy ? '…' : '↑ Escalate'}
    </button>
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
