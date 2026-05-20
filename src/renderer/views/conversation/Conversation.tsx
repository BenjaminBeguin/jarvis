import { useEffect, useMemo, useRef, useState } from 'react';

import type { TaskEvent } from '../../../shared/types';
import { buildItems } from '../../conversation/buildItems';
import type { ChatItem, ConversationMode } from '../../conversation/types';
import { MarkdownText } from '../MarkdownText';

/**
 * Unified chat-transcript renderer. Subscribes to a task's events
 * and renders them as chat bubbles. Replaces three earlier builders
 * that all parsed SDKMessages differently.
 *
 * `mode='cozy'` (default) — Claude-Code-Desktop-style:
 *   - User messages right-aligned, assistant left.
 *   - Tool calls collapse to a single line ("⚙ Read foo.ts:42 ▸");
 *     click to expand input + result.
 *   - Successful tool calls without informative output stay
 *     collapsed; errored ones expand by default.
 *   - "Thinking" / system events render as a dim single-line row
 *     that expands to the full payload.
 *   - Result event becomes a small footer pill.
 *
 * `mode='full'` — everything expanded by default, system events
 * visible, tool input + result JSON shown inline. The Observatory
 * panel uses this for serious debugging.
 *
 * Auto-scrolls to the bottom on each new event unless the user has
 * scrolled up — that locks the view until they scroll back near
 * the bottom.
 */

export interface ConversationProps {
  taskId: string;
  mode?: ConversationMode;
}

export function Conversation({ taskId, mode = 'cozy' }: ConversationProps) {
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  // Load history + subscribe to live events.
  useEffect(() => {
    let cancelled = false;
    void window.jarvis.getTaskHistory(taskId).then((history) => {
      if (cancelled) return;
      setEvents(history);
    });
    const off = window.jarvis.onTaskEvent(({ taskId: id, event }) => {
      if (id !== taskId) return;
      setEvents((prev) => [...prev, event]);
    });
    return () => {
      cancelled = true;
      off();
    };
  }, [taskId]);

  const items = useMemo(() => buildItems(events), [events]);

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

  // Auto-scroll on new items when sticky.
  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const body = bodyRef.current;
    if (!body) return;
    body.scrollTop = body.scrollHeight;
  }, [items]);

  return (
    <div className={`convo convo--${mode}`} ref={bodyRef}>
      {items.length === 0 && (
        <div className="convo__empty">
          {mode === 'cozy'
            ? 'Waiting for the agent to respond…'
            : 'No events yet.'}
        </div>
      )}
      {items.map((item) => (
        <ChatItemRow key={item.key} item={item} mode={mode} />
      ))}
    </div>
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
      <div className="convo__row convo__row--user">
        <div className="convo__bubble convo__bubble--user">
          <MarkdownText>{item.text}</MarkdownText>
        </div>
      </div>
    );
  }

  if (item.kind === 'assistant') {
    return (
      <div className="convo__row convo__row--assistant">
        <div className="convo__bubble convo__bubble--assistant">
          <MarkdownText>{item.text}</MarkdownText>
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
    const dur =
      item.durationMs >= 60_000
        ? `${(item.durationMs / 1000 / 60).toFixed(1)}m`
        : item.durationMs >= 1000
          ? `${(item.durationMs / 1000).toFixed(1)}s`
          : `${item.durationMs}ms`;
    const cost = item.costUsd > 0 ? ` · $${item.costUsd.toFixed(4)}` : '';
    return (
      <div className="convo__row convo__row--result">
        <div className="convo__result">Done · {dur}{cost}</div>
      </div>
    );
  }

  if (item.kind === 'error') {
    return (
      <div className="convo__row convo__row--error">
        <div className="convo__error">
          <span className="convo__error-glyph">✗</span>
          <pre className="convo__error-body">{item.body}</pre>
        </div>
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
  // Default-expanded in full mode, or when the tool errored.
  const [open, setOpen] = useState<boolean>(mode === 'full' || item.isError);
  const summary = item.preview ?? '';
  return (
    <div
      className={`convo__row convo__row--tool${item.isError ? ' convo__row--tool-error' : ''}`}
    >
      <button
        type="button"
        className="convo__tool-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="convo__tool-glyph">{item.isError ? '✗' : '⚙'}</span>
        <span className="convo__tool-name">{item.name}</span>
        {summary && <span className="convo__tool-summary">{summary}</span>}
        <span className="convo__tool-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="convo__tool-detail">
          {item.input !== null && item.input !== undefined && (
            <>
              <div className="convo__tool-label">Input</div>
              <pre className="convo__tool-block">
                {typeof item.input === 'string'
                  ? item.input
                  : JSON.stringify(item.input, null, 2)}
              </pre>
            </>
          )}
          {item.result && (
            <>
              <div className="convo__tool-label">
                {item.isError ? 'Error' : 'Result'}
              </div>
              <pre
                className={`convo__tool-block${item.isError ? ' convo__tool-block--error' : ''}`}
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
  // Cozy: hide system events except as a single dim "thinking…" line.
  // Full: show everything inline, no toggle pressure.
  return (
    <div className="convo__row convo__row--thinking">
      <button
        type="button"
        className="convo__thinking-head"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="convo__thinking-glyph">✦</span>
        <span className="convo__thinking-label">
          {item.subtype === 'system'
            ? 'thinking…'
            : `${item.subtype}…`}
        </span>
        <span className="convo__thinking-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <pre className="convo__thinking-body">{item.body}</pre>
      )}
    </div>
  );
}
