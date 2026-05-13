import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { TaskEvent, TaskSummary } from '../../shared/types';
import { AudioCapture } from '../voice/AudioCapture';
import { MarkdownText } from './MarkdownText';

interface CardState {
  taskId: string;
  summary: TaskSummary | null;
  events: TaskEvent[];
}

function statusLabel(status: string, lastTool: string | null): string {
  switch (status) {
    case 'thinking':
      return 'thinking';
    case 'streaming':
      return lastTool ? `using ${lastTool}` : 'replying';
    case 'awaiting':
      return 'awaiting · reply to continue';
    case 'done':
      return 'done';
    case 'errored':
      return 'errored';
    case 'aborted':
      return 'aborted';
    default:
      return status;
  }
}

function composeAnswer(events: TaskEvent[]): {
  text: string;
  toolCount: number;
  lastTool: string | null;
} {
  let text = '';
  let toolCount = 0;
  let lastTool: string | null = null;
  for (const e of events) {
    const msg = e.msg as { type?: string; message?: { content?: unknown } } | undefined;
    if (!msg) continue;
    if (msg.type !== 'assistant') continue;
    const content = msg.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        text += block['text'];
      } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        toolCount++;
        lastTool = block['name'];
      }
    }
  }
  return { text, toolCount, lastTool };
}

function cleanTranscript(raw: string): string {
  const stripped = raw
    .replace(/\[\s*BLANK[_ ]AUDIO\s*\]/gi, '')
    .replace(/\[\s*INAUDIBLE\s*\]/gi, '')
    .replace(/\[\s*MUSIC\s*\]/gi, '')
    .replace(/\(\s*silence\s*\)/gi, '')
    .replace(/\(\s*music\s*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  const normalized = stripped.toLowerCase().replace(/[.!?,;:'"-]+$/, '').trim();
  if (normalized === '' || normalized === 'thank you' || normalized === 'you') return '';
  return stripped;
}

export function AnswerHUD() {
  const [cards, setCards] = useState<CardState[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  // Tasks the user has acknowledged. Persisted in renderer memory only — if
  // the HUD window is destroyed (last ack) we don't need them anymore.
  const ackedRef = useRef<Set<string>>(new Set());

  // Subscribe to track-task pushes from main. When a new taskId arrives,
  // open a card, fetch history, and subscribe to live events.
  useEffect(() => {
    const off = window.jarvis.onAnswerHudTrack((taskId) => {
      if (!taskId || ackedRef.current.has(taskId)) return;
      setCards((prev) => {
        if (prev.some((c) => c.taskId === taskId)) return prev;
        return [{ taskId, summary: null, events: [] }, ...prev];
      });
      void window.jarvis.getTaskHistory(taskId).then((evts) => {
        setCards((prev) =>
          prev.map((c) => (c.taskId === taskId ? { ...c, events: evts } : c)),
        );
      });
      // Pull the latest summary too — listTasks is cheap.
      void window.jarvis.listTasks().then((tasks) => {
        const t = tasks.find((x) => x.id === taskId);
        if (!t) return;
        setCards((prev) =>
          prev.map((c) => (c.taskId === taskId ? { ...c, summary: t } : c)),
        );
      });
    });
    return off;
  }, []);

  // Global subscriptions: just filter to tracked taskIds.
  useEffect(() => {
    const offE = window.jarvis.onTaskEvent(({ taskId, event }) => {
      setCards((prev) => {
        const idx = prev.findIndex((c) => c.taskId === taskId);
        if (idx === -1) return prev;
        const card = prev[idx];
        if (!card) return prev;
        if (card.events.some((e) => e.seq === event.seq)) return prev;
        const next = prev.slice();
        next[idx] = { ...card, events: [...card.events, event] };
        return next;
      });
    });
    const offS = window.jarvis.onTaskStatus((summary) => {
      setCards((prev) => {
        const idx = prev.findIndex((c) => c.taskId === summary.id);
        if (idx === -1) return prev;
        const card = prev[idx];
        if (!card) return prev;
        const next = prev.slice();
        next[idx] = { ...card, summary };
        return next;
      });
    });
    return () => {
      offE();
      offS();
    };
  }, []);

  const ackCard = useCallback((taskId: string) => {
    ackedRef.current.add(taskId);
    setCards((prev) => prev.filter((c) => c.taskId !== taskId));
  }, []);

  // Hide the HUD window once the user has cleared the stack. Hidden, not
  // closed — keeps subscriptions warm for the next palette dispatch.
  useEffect(() => {
    if (cards.length === 0) {
      const t = setTimeout(() => {
        if (cards.length === 0) void window.jarvis.hideAnswerHud();
      }, 240);
      return () => clearTimeout(t);
    }
  }, [cards.length]);

  // Resize the HUD window to fit the stack.
  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      void window.jarvis.resizeAnswerHud(Math.ceil(rect.height) + 8);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="hud" ref={rootRef}>
      {cards.map((card) => (
        <AnswerCard key={card.taskId} card={card} onAck={() => ackCard(card.taskId)} />
      ))}
    </div>
  );
}

interface AnswerCardProps {
  card: CardState;
  onAck: () => void;
}

function AnswerCard({ card, onAck }: AnswerCardProps) {
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const captureRef = useRef<AudioCapture | null>(null);

  const answer = useMemo(() => composeAnswer(card.events), [card.events]);
  const summary = card.summary;
  const answerStatus: string = !summary
    ? 'thinking'
    : summary.awaitingInput
    ? 'awaiting'
    : summary.status === 'running'
    ? answer.text.length > 0 || answer.toolCount > 0
      ? 'streaming'
      : 'thinking'
    : summary.status === 'completed'
    ? 'done'
    : summary.status;

  const canReply = !!summary && (summary.awaitingInput || summary.status === 'running');

  const sendReply = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || sending) return;
      setError(null);
      setSending(true);
      try {
        const ok = await window.jarvis.sendTaskMessage(card.taskId, trimmed);
        if (!ok) setError("Couldn't send — task isn't accepting input.");
        else setReply('');
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setSending(false);
      }
    },
    [card.taskId, sending],
  );

  const startVoice = async () => {
    if (captureRef.current || transcribing) return;
    setError(null);
    try {
      const perm = await window.jarvis.requestMicAccess();
      if (!perm.granted) {
        setError(
          perm.status === 'denied'
            ? 'Mic denied. Enable in System Settings → Privacy → Microphone.'
            : `Mic unavailable (${perm.status}).`,
        );
        return;
      }
    } catch {
      // probe failed; let the actual capture surface the error
    }
    const capture = new AudioCapture();
    try {
      await capture.start();
    } catch (e) {
      setError(`Mic open failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    captureRef.current = capture;
    setListening(true);
  };

  const stopVoice = async () => {
    const capture = captureRef.current;
    if (!capture) return;
    captureRef.current = null;
    setListening(false);
    let result;
    try {
      result = await capture.stop();
    } catch (e) {
      setError(`Audio capture failed: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (result.pcm.length < 16_000 * 0.3) {
      setError("Didn't hear anything — hold the mic while speaking.");
      return;
    }
    setTranscribing(true);
    try {
      const raw = await window.jarvis.transcribe(result.pcm.buffer as ArrayBuffer);
      const transcript = cleanTranscript(raw);
      if (!transcript) {
        setError("Couldn't make out the audio.");
        return;
      }
      await sendReply(transcript);
    } catch (e) {
      setError(`Transcribe failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTranscribing(false);
    }
  };

  const open = () => {
    void window.jarvis.openObservatory();
  };

  return (
    <article className={`hud__card hud__card--${answerStatus}`}>
      <header className="hud__card-bar">
        <span className={`hud__dot hud__dot--${answerStatus}`} />
        <span className="hud__card-status">{statusLabel(answerStatus, answer.lastTool)}</span>
        <div className="hud__card-actions">
          <button onClick={open} title="Open in observatory">↗</button>
          <button onClick={onAck} title="Acknowledge — remove from HUD">✓</button>
        </div>
      </header>
      <div className="hud__card-body">
        {answer.text ? (
          <MarkdownText>{answer.text}</MarkdownText>
        ) : (
          <div className="hud__card-thinking">thinking…</div>
        )}
      </div>
      {error && <div className="hud__card-error">{error}</div>}
      {canReply && (
        <div className="hud__card-reply">
          <input
            value={reply}
            onChange={(e) => setReply(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendReply(reply);
              }
            }}
            placeholder={
              listening
                ? 'Listening…'
                : transcribing
                ? 'Transcribing…'
                : sending
                ? 'Sending…'
                : 'Reply · ↵ to send'
            }
            disabled={sending || transcribing}
          />
          <button
            className={`mic${listening ? ' listening' : ''}${transcribing ? ' transcribing' : ''}`}
            title={listening ? 'Release to send' : 'Hold to dictate'}
            onMouseDown={() => void startVoice()}
            onMouseUp={() => void stopVoice()}
            onMouseLeave={() => void stopVoice()}
            disabled={transcribing || sending}
            aria-label="Voice reply"
          >
            <svg width="11" height="11" viewBox="0 0 12 12" fill="none">
              <rect x="4" y="2" width="4" height="6" rx="2" stroke="currentColor" />
              <path d="M3 6.5C3 8 4 9 6 9C8 9 9 8 9 6.5" stroke="currentColor" strokeLinecap="round" />
              <line x1="6" y1="9" x2="6" y2="11" stroke="currentColor" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      )}
    </article>
  );
}
