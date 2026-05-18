import { useEffect, useMemo, useRef, useState } from 'react';

import type { TaskEvent } from '../../../shared/types';

/**
 * Chat-tab body for the workflows page. The user types a natural-
 * language request, we launch a `workflow-author` task, and stream
 * its events back inline so they can see the agent reading,
 * thinking, and writing the JSON file — instead of a fire-and-
 * forget toast.
 *
 * One "exchange" = one launched task. We keep the most recent few in
 * state so the user can scroll back through what they asked the
 * agent to do without leaving the workflow page.
 *
 * Layout matches the other dock tabs: scrollable transcript on top,
 * input bar pinned at the bottom.
 */

export interface WorkflowChatProps {
  selectedId: string | null;
}

interface Exchange {
  id: string;
  taskId: string;
  prompt: string;
  startedAt: number;
  events: TaskEvent[];
  /** Whether we've received the `result` SDK message — drives the
   *  "completed" footer rendering. */
  done: boolean;
  /** Set when we get a result with success=false or jarvis_error. */
  errored: boolean;
}

interface StreamItem {
  kind: 'assistant-text' | 'tool' | 'result-success' | 'result-error';
  key: string;
  /** Text body for assistant rows or tool inputs/results. */
  text?: string;
  toolName?: string;
  toolError?: boolean;
  toolResult?: string;
  /** Final-result footer fields. */
  durationMs?: number;
  costUsd?: number;
  errorText?: string;
}

const MAX_EXCHANGES = 4;

export function WorkflowChat({ selectedId }: WorkflowChatProps) {
  const [prompt, setPrompt] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Subscribe to global task events; route each one to its matching
  // exchange. One subscription covers all live exchanges — we only
  // care about events whose taskId is in our exchanges array.
  useEffect(() => {
    const off = window.jarvis.onTaskEvent(({ taskId, event }) => {
      setExchanges((prev) => {
        const idx = prev.findIndex((x) => x.taskId === taskId);
        if (idx === -1) return prev;
        const msg = event.msg as { type?: string; subtype?: string } | undefined;
        const next = prev.slice();
        const current = next[idx]!;
        const updated: Exchange = {
          ...current,
          events: [...current.events, event],
        };
        if (msg?.type === 'result') {
          updated.done = true;
          // `subtype: 'success'` is the SDK's happy path. Anything
          // else (error_max_turns, error_during_execution) → red.
          if (msg.subtype !== 'success') updated.errored = true;
        } else if (msg?.type === 'jarvis_error') {
          updated.done = true;
          updated.errored = true;
        }
        next[idx] = updated;
        return next;
      });
    });
    return off;
  }, []);

  // Auto-scroll to the bottom on each render — the new event is
  // always the most interesting thing on screen.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [exchanges]);

  const send = async (): Promise<void> => {
    const text = prompt.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      const framed = selectedId
        ? `SELECTED_WORKFLOW_ID: ${selectedId}\n\nUser request:\n${text}`
        : `No workflow currently selected.\n\nUser request:\n${text}`;
      const task = await window.jarvis.launchTask({
        prompt: framed,
        skillId: 'workflow-author',
        origin: 'palette',
      });
      const exchange: Exchange = {
        id: `${task.id}-${Date.now()}`,
        taskId: task.id,
        prompt: text,
        startedAt: Date.now(),
        events: [],
        done: false,
        errored: false,
      };
      setExchanges((prev) => [...prev, exchange].slice(-MAX_EXCHANGES));
      setPrompt('');
    } catch (err) {
      // Surface the launch failure as a synthetic errored exchange so
      // the user sees the message inline rather than just a toast.
      setExchanges((prev) =>
        [
          ...prev,
          {
            id: `local-${Date.now()}`,
            taskId: '',
            prompt: text,
            startedAt: Date.now(),
            events: [],
            done: true,
            errored: true,
            launchError: err instanceof Error ? err.message : String(err),
          } as Exchange & { launchError: string },
        ].slice(-MAX_EXCHANGES),
      );
    } finally {
      setBusy(false);
    }
  };

  const clear = (): void => {
    setExchanges([]);
  };

  return (
    <div className="wf-chat">
      <div className="wf-chat__transcript" ref={transcriptRef}>
        {exchanges.length === 0 ? (
          <div className="wf-chat__empty">
            <p>
              Describe what you want this workflow to do (or how to change
              the current one). The agent reads / edits{' '}
              <code>~/.jarvis/workflows/&lt;id&gt;.json</code> directly; the
              editor reloads when it's done.
            </p>
            <p className="wf-chat__empty-hint">
              {selectedId ? (
                <>
                  Editing <code>{selectedId}</code>. Tip: ⌘↩ to send.
                </>
              ) : (
                <>No workflow selected — the agent will create a new one.</>
              )}
            </p>
          </div>
        ) : (
          exchanges.map((x) => <ExchangeView key={x.id} exchange={x} />)
        )}
      </div>
      <div className="wf-chat__compose">
        <textarea
          className="wf-chat__input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault();
              void send();
            }
          }}
          placeholder={
            selectedId
              ? 'e.g. add a notify step that pings me when the inbox-write produces > 5 items'
              : 'e.g. build a workflow that fetches my GitHub notifications every 10m and writes them to the inbox'
          }
          spellCheck={false}
          rows={3}
          disabled={busy}
        />
        <div className="wf-chat__compose-bar">
          {exchanges.length > 0 && (
            <button
              type="button"
              className="wf-chat__clear"
              onClick={clear}
              title="Clear transcript"
            >
              Clear
            </button>
          )}
          <div className="wf-dock__spacer" />
          <button
            type="button"
            className="wf-chat__send"
            onClick={() => void send()}
            disabled={busy || prompt.trim().length === 0}
          >
            {busy ? 'Launching…' : 'Send (⌘↩)'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ExchangeView({ exchange }: { exchange: Exchange }) {
  const stream = useMemo(() => buildStream(exchange), [exchange]);
  const elapsed = exchange.done
    ? null
    : Math.max(0, Math.floor((Date.now() - exchange.startedAt) / 1000));

  return (
    <div
      className={`wf-chat__exchange${exchange.errored ? ' wf-chat__exchange--errored' : ''}${exchange.done ? '' : ' wf-chat__exchange--live'}`}
    >
      <div className="wf-chat__prompt">
        <span className="wf-chat__prompt-glyph">›</span>
        <span className="wf-chat__prompt-text">{exchange.prompt}</span>
        {exchange.taskId && (
          <button
            type="button"
            className="wf-chat__open-obs"
            title="Open the full transcript in the Observatory"
            onClick={() => void window.jarvis.openObservatory(exchange.taskId)}
          >
            ↗
          </button>
        )}
      </div>
      {stream.length === 0 && !exchange.done && (
        <div className="wf-chat__pending">
          Agent is thinking{elapsed != null ? ` · ${elapsed}s` : ''}…
        </div>
      )}
      {stream.map((item) => (
        <StreamItemRow key={item.key} item={item} />
      ))}
    </div>
  );
}

function StreamItemRow({ item }: { item: StreamItem }) {
  if (item.kind === 'assistant-text') {
    return <div className="wf-chat__assistant">{item.text}</div>;
  }
  if (item.kind === 'tool') {
    return (
      <div
        className={`wf-chat__tool${item.toolError ? ' wf-chat__tool--errored' : ''}`}
      >
        <span className="wf-chat__tool-glyph">⚙</span>
        <span className="wf-chat__tool-name">{item.toolName}</span>
        {item.text && (
          <span className="wf-chat__tool-arg" title={item.text}>
            {item.text}
          </span>
        )}
        {item.toolError && item.toolResult && (
          <pre className="wf-chat__tool-error">{item.toolResult}</pre>
        )}
      </div>
    );
  }
  if (item.kind === 'result-success') {
    return (
      <div className="wf-chat__result wf-chat__result--ok">
        Done · {formatDuration(item.durationMs ?? 0)}
        {item.costUsd ? ` · $${item.costUsd.toFixed(4)}` : ''}
      </div>
    );
  }
  // result-error
  return (
    <div className="wf-chat__result wf-chat__result--err">
      {item.errorText ?? 'Failed'}
    </div>
  );
}

function buildStream(exchange: Exchange): StreamItem[] {
  const launchError = (exchange as Exchange & { launchError?: string })
    .launchError;
  if (launchError) {
    return [{ kind: 'result-error', key: 'launch-err', errorText: launchError }];
  }

  const items: StreamItem[] = [];
  const toolIdToIndex = new Map<string, number>();

  for (const event of exchange.events) {
    const msg = event.msg as
      | ({ type?: string } & Record<string, unknown>)
      | undefined;
    if (!msg || typeof msg !== 'object') continue;

    if (msg.type === 'assistant') {
      const content = (msg['message'] as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] === 'text' && typeof block['text'] === 'string') {
          const text = (block['text'] as string).trim();
          if (text) {
            items.push({
              kind: 'assistant-text',
              key: `${event.seq}-a-${items.length}`,
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
            toolName: block['name'] as string,
            text: summariseToolInput(
              block['name'] as string,
              block['input'],
            ),
          });
          if (id) toolIdToIndex.set(id, idx);
        }
      }
      continue;
    }

    if (msg.type === 'user') {
      const content = (msg['message'] as { content?: unknown })?.content;
      if (!Array.isArray(content)) continue;
      for (const block of content as Array<Record<string, unknown>>) {
        if (block['type'] !== 'tool_result') continue;
        const id =
          typeof block['tool_use_id'] === 'string'
            ? (block['tool_use_id'] as string)
            : null;
        if (!id) continue;
        const idx = toolIdToIndex.get(id);
        if (idx == null) continue;
        const tool = items[idx];
        if (!tool || tool.kind !== 'tool') continue;
        const isError = block['is_error'] === true;
        if (isError) {
          tool.toolError = true;
          tool.toolResult = extractText(block['content']);
        }
      }
      continue;
    }

    if (msg.type === 'result') {
      const r = msg as {
        total_cost_usd?: number;
        duration_ms?: number;
        subtype?: string;
      };
      if (r.subtype === 'success') {
        items.push({
          kind: 'result-success',
          key: `${event.seq}-final`,
          durationMs: r.duration_ms ?? 0,
          costUsd: r.total_cost_usd ?? 0,
        });
      } else {
        items.push({
          kind: 'result-error',
          key: `${event.seq}-final-err`,
          errorText: r.subtype ?? 'Failed',
        });
      }
      continue;
    }

    if (msg.type === 'jarvis_error') {
      items.push({
        kind: 'result-error',
        key: `${event.seq}-jerr`,
        errorText: String((msg as { error?: unknown }).error ?? 'Error'),
      });
    }
  }

  return items;
}

/** Short, one-line summary of a tool's input. The full transcript
 *  lives in the Observatory; here we only want the user to see WHAT
 *  the agent is doing (read this file, write that one). */
function summariseToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const i = input as Record<string, unknown>;
  if (name === 'Read' || name === 'Write' || name === 'Edit') {
    const path = typeof i['file_path'] === 'string' ? i['file_path'] : '';
    return path ? shortenPath(path) : '';
  }
  if (name === 'Glob') {
    const pat = typeof i['pattern'] === 'string' ? i['pattern'] : '';
    return pat;
  }
  if (name === 'Grep') {
    const pat = typeof i['pattern'] === 'string' ? i['pattern'] : '';
    return pat;
  }
  if (name === 'Bash') {
    const cmd = typeof i['command'] === 'string' ? i['command'] : '';
    return cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd;
  }
  return '';
}

function shortenPath(full: string): string {
  // Collapse the long ~/.jarvis prefix to keep the bubble tidy.
  const home = '/Users/';
  if (full.startsWith(home)) {
    const parts = full.split('/');
    if (parts.length > 4) {
      return `~/${parts.slice(4).join('/')}`;
    }
  }
  return full;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return (content as Array<Record<string, unknown>>)
      .filter((b) => b['type'] === 'text' && typeof b['text'] === 'string')
      .map((b) => b['text'] as string)
      .join('\n');
  }
  return '';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.floor(s % 60);
  return `${m}m${rem}s`;
}
