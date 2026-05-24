import { useEffect, useMemo, useState } from 'react';

import { buildItems } from '../../conversation/buildItems';
import type { ChatItem } from '../../conversation/types';
import type { TaskEvent, TaskSummary } from '../../../shared/types';
import { api } from './api';
import { navigateMobile } from './MobileApp';
import { useSse } from './useSse';
import type { MobileAuth } from './types';

interface Props {
  auth: MobileAuth;
  taskId: string;
}

interface TaskBundle {
  summary: TaskSummary;
  events: TaskEvent[];
}

/**
 * One conversation's transcript on the phone. Read-only for v1 —
 * the composer (text + mic + send) lands in the next two
 * commits. Uses the shared buildItems builder so the rendering
 * stays in lockstep with desktop.
 */
export function MobileConversation({ auth, taskId }: Props) {
  const [bundle, setBundle] = useState<TaskBundle | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const data = await api<TaskBundle>(auth, `/v1/tasks/${taskId}`);
      setBundle(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth.baseUrl, auth.token, taskId]);

  // Refetch when this task's status changes (new event arrives,
  // turn ends, etc.). v1 polls on every transition — a future
  // commit can subscribe to per-event SSE for incremental
  // updates if it feels laggy.
  useSse(auth, {
    onTaskStatus: (payload) => {
      const p = payload as { id?: string } | null;
      if (p?.id === taskId) void refresh();
    },
  });

  const items = useMemo<ChatItem[]>(
    () => (bundle ? buildItems(bundle.events) : []),
    [bundle],
  );

  return (
    <div className="mobile-conv">
      <header className="mobile-conv__head">
        <button
          type="button"
          className="mobile-conv__back"
          onClick={() => navigateMobile('conversations')}
          aria-label="Back to threads"
        >
          ←
        </button>
        <div className="mobile-conv__title-wrap">
          <h2 className="mobile-conv__title">
            {bundle?.summary.title ?? 'Conversation'}
          </h2>
          {bundle && (
            <span className="mobile-conv__meta">
              {bundle.summary.status === 'running' &&
              bundle.summary.awaitingInput
                ? 'awaiting reply'
                : bundle.summary.status}
              {bundle.summary.costUsd > 0 &&
                ` · $${bundle.summary.costUsd.toFixed(4)}`}
            </span>
          )}
        </div>
      </header>

      {error && <div className="mobile-inbox__error">{error}</div>}
      {!bundle && !error && (
        <div className="mobile-inbox__empty">Loading…</div>
      )}

      <ul className="mobile-conv__items">
        {items.map((it) => (
          <Row key={it.key} item={it} />
        ))}
      </ul>

      {bundle && canReply(bundle.summary) && (
        <Composer
          auth={auth}
          taskId={taskId}
          resuming={bundle.summary.status !== 'running'}
          onSent={refresh}
        />
      )}
    </div>
  );
}

function canReply(summary: TaskSummary): boolean {
  if (summary.origin === 'external') return false;
  // Same gate as the desktop Conversation: live + awaiting,
  // OR completed with a saved sdkSessionId so the runner can
  // spin up a resume turn.
  if (summary.status === 'running' && summary.awaitingInput) return true;
  if (summary.status === 'completed' && summary.sdkSessionId) return true;
  return false;
}

function Composer({
  auth,
  taskId,
  resuming,
  onSent,
}: {
  auth: MobileAuth;
  taskId: string;
  resuming: boolean;
  onSent: () => void;
}) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async (): Promise<void> => {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    try {
      await api<{ ok: boolean }>(auth, `/v1/tasks/${taskId}/message`, {
        method: 'POST',
        body: JSON.stringify({ text: value }),
      });
      setText('');
      onSent();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mobile-conv__composer">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={
          resuming
            ? 'Continue the conversation. Resumes the session.'
            : 'Reply…'
        }
        rows={2}
        disabled={sending}
        spellCheck
      />
      {error && <div className="mobile-conv__composer-error">{error}</div>}
      <button
        type="button"
        className="mobile-conv__send"
        onClick={() => void send()}
        disabled={sending || !text.trim()}
      >
        {sending ? '…' : resuming ? 'Continue' : 'Send'}
      </button>
    </div>
  );
}

function Row({ item }: { item: ChatItem }) {
  if (item.kind === 'user') {
    return (
      <li className="mobile-conv__row mobile-conv__row--user">
        <span className="mobile-conv__chip">you</span>
        <div className="mobile-conv__body">{item.text}</div>
      </li>
    );
  }
  if (item.kind === 'assistant') {
    return (
      <li className="mobile-conv__row mobile-conv__row--assistant">
        <div className="mobile-conv__body">{item.text}</div>
      </li>
    );
  }
  if (item.kind === 'tool') {
    const summary = item.preview ?? '';
    return (
      <li
        className={`mobile-conv__row mobile-conv__row--tool${item.isError ? ' mobile-conv__row--error' : ''}`}
      >
        <span className="mobile-conv__glyph" aria-hidden>
          {item.isError ? '✗' : '⚙'}
        </span>
        <span className="mobile-conv__tool-name">{item.name}</span>
        {summary && <span className="mobile-conv__tool-arg">{summary}</span>}
      </li>
    );
  }
  if (item.kind === 'thinking') {
    return (
      <li className="mobile-conv__row mobile-conv__row--thinking">
        ✦ {item.subtype === 'system' ? 'thinking…' : `${item.subtype}…`}
      </li>
    );
  }
  if (item.kind === 'result') {
    return null;
  }
  if (item.kind === 'error') {
    return (
      <li className="mobile-conv__row mobile-conv__row--error-body">
        ⚠ {item.body}
      </li>
    );
  }
  return null;
}
