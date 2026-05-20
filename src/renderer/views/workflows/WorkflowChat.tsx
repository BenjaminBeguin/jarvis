import { useEffect, useRef, useState } from 'react';

import { conversationStore } from '../../conversation/conversation-store';
import { Conversation } from '../conversation/Conversation';

/**
 * Chat tab body for the workflows page. The user types a natural-
 * language request; we launch a `workflow-author` task. Each launched
 * task gets a one-line "exchange" entry that embeds the unified
 * <Conversation> renderer, so the workflows dock chat looks
 * identical to every other AI conversation in the app.
 *
 * The exchange ribbon also gets a "↗ open in sidebar" jump that
 * pushes the task into the conversation-store — useful when the
 * dock tab is too narrow to read the agent's tool calls comfortably.
 */

export interface WorkflowChatProps {
  selectedId: string | null;
}

interface Exchange {
  id: string;
  taskId: string;
  prompt: string;
  /** Synthetic error when the launch itself failed (no task id). */
  launchError?: string;
}

const MAX_EXCHANGES = 4;

export function WorkflowChat({ selectedId }: WorkflowChatProps) {
  const [prompt, setPrompt] = useState<string>('');
  const [busy, setBusy] = useState<boolean>(false);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const transcriptRef = useRef<HTMLDivElement | null>(null);

  // Auto-scroll to the bottom whenever a new exchange is added —
  // the new task is what the user wants to see.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [exchanges.length]);

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
      };
      setExchanges((prev) => [...prev, exchange].slice(-MAX_EXCHANGES));
      setPrompt('');
    } catch (err) {
      setExchanges((prev) =>
        [
          ...prev,
          {
            id: `local-${Date.now()}`,
            taskId: '',
            prompt: text,
            launchError: err instanceof Error ? err.message : String(err),
          },
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
  const openInSidebar = (): void => {
    if (!exchange.taskId) return;
    conversationStore.open({
      taskId: exchange.taskId,
      title: exchange.prompt.slice(0, 60),
      origin: 'user-click',
    });
  };

  if (exchange.launchError) {
    return (
      <div className="wf-chat__exchange wf-chat__exchange--errored">
        <div className="wf-chat__prompt">
          <span className="wf-chat__prompt-glyph">›</span>
          <span className="wf-chat__prompt-text">{exchange.prompt}</span>
        </div>
        <div className="wf-chat__launch-error">
          Failed to launch: {exchange.launchError}
        </div>
      </div>
    );
  }

  return (
    <div className="wf-chat__exchange">
      <div className="wf-chat__prompt">
        <span className="wf-chat__prompt-glyph">›</span>
        <span className="wf-chat__prompt-text">{exchange.prompt}</span>
        <button
          type="button"
          className="wf-chat__open-obs"
          title="Open this conversation in the sidebar"
          onClick={openInSidebar}
        >
          ↗
        </button>
      </div>
      <div className="wf-chat__convo">
        <Conversation taskId={exchange.taskId} mode="cozy" />
      </div>
    </div>
  );
}
