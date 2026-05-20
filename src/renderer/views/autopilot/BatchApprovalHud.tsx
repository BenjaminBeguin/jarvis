import { useEffect, useMemo, useState } from 'react';

import type { BatchDecision } from '../../../shared/types';

/**
 * Table-shaped approval HUD for `batch-prompt-output`. Listens on
 * the same `autopilotApprovalRequested` channel as ApprovalHud and
 * routes via payload shape: when `items` is present, this component
 * mounts; otherwise the single-item HUD takes over.
 *
 * Per-row controls: Reject / Reject + note / Accept. Editing a
 * row's draft before Accept becomes positive feedback ("the user's
 * edit is the right shape").
 *
 * Footer actions: Accept all, Reject all, Done (defers undecided
 * rows — they'll re-appear on the next autopilot tick).
 *
 * Edited drafts ride along with the accept decision so a downstream
 * node could fan them out (e.g. as Slack chat.postMessage calls).
 */

interface BatchRequest {
  requestId: string;
  workflowId: string;
  title: string;
  summary?: string;
  items: Array<{
    id: string;
    preview: Array<{ label: string; value: string }>;
    draft: string;
    verdict?: string;
    context?: string;
  }>;
}

type RowState = {
  decision?: 'accept' | 'reject' | 'skip';
  editedDraft: string;
  feedbackOpen: boolean;
  feedback: string;
};

export function BatchApprovalHud() {
  const [queue, setQueue] = useState<BatchRequest[]>([]);
  const [rowStates, setRowStates] = useState<Map<string, RowState>>(new Map());
  const head = queue[0] ?? null;

  // Subscribe to incoming requests; only push when the payload is
  // batch-shaped (items present). Single-item payloads belong to
  // ApprovalHud.
  useEffect(() => {
    const off = window.jarvis.onAutopilotApprovalRequested((req) => {
      if (!Array.isArray((req as { items?: unknown }).items)) return;
      setQueue((prev) => [...prev, req as BatchRequest]);
    });
    return off;
  }, []);

  // Reset row state when the head request changes.
  useEffect(() => {
    if (!head) return;
    const next = new Map<string, RowState>();
    for (const item of head.items) {
      next.set(item.id, {
        editedDraft: item.draft,
        feedbackOpen: false,
        feedback: '',
      });
    }
    setRowStates(next);
  }, [head?.requestId]);

  if (!head) return null;

  const setRow = (id: string, patch: Partial<RowState>): void => {
    setRowStates((prev) => {
      const next = new Map(prev);
      const cur = next.get(id) ?? {
        editedDraft: '',
        feedbackOpen: false,
        feedback: '',
      };
      next.set(id, { ...cur, ...patch });
      return next;
    });
  };

  const finalize = (decisions: BatchDecision[]): void => {
    void window.jarvis.autopilotApproveBatch(head.requestId, decisions);
    setQueue((prev) => prev.slice(1));
  };

  const acceptAll = (): void => {
    const decisions: BatchDecision[] = head.items.map((item) => {
      const state = rowStates.get(item.id);
      return {
        rowId: item.id,
        decision: 'accept',
        editedDraft: state?.editedDraft,
      };
    });
    finalize(decisions);
  };

  const rejectAll = (): void => {
    const decisions: BatchDecision[] = head.items.map((item) => ({
      rowId: item.id,
      decision: 'reject',
      feedback: 'bulk-rejected',
    }));
    finalize(decisions);
  };

  const done = (): void => {
    const decisions: BatchDecision[] = head.items.map((item) => {
      const state = rowStates.get(item.id);
      if (!state?.decision || state.decision === 'skip') {
        return { rowId: item.id, decision: 'skip' };
      }
      if (state.decision === 'accept') {
        return {
          rowId: item.id,
          decision: 'accept',
          editedDraft: state.editedDraft,
        };
      }
      return {
        rowId: item.id,
        decision: 'reject',
        feedback: state.feedback.trim() || undefined,
      };
    });
    finalize(decisions);
  };

  // Decided count drives the footer label so the user sees progress.
  const decidedCount = useMemo(() => {
    let n = 0;
    for (const [, s] of rowStates) {
      if (s.decision === 'accept' || s.decision === 'reject') n++;
    }
    return n;
  }, [rowStates]);

  return (
    <div className="autopilot-batch-hud" role="dialog" aria-modal="true">
      <div className="autopilot-batch-hud__card">
        <header className="autopilot-batch-hud__head">
          <span className="autopilot-batch-hud__glyph">⚡</span>
          <span className="autopilot-batch-hud__title">{head.title}</span>
          <span className="autopilot-batch-hud__progress">
            {decidedCount} / {head.items.length} decided
          </span>
        </header>
        {head.summary && (
          <div className="autopilot-batch-hud__summary">{head.summary}</div>
        )}
        <div className="autopilot-batch-hud__rows">
          {head.items.map((item) => {
            const state = rowStates.get(item.id) ?? {
              editedDraft: item.draft,
              feedbackOpen: false,
              feedback: '',
            };
            return (
              <BatchRow
                key={item.id}
                item={item}
                state={state}
                onPatch={(p) => setRow(item.id, p)}
              />
            );
          })}
        </div>
        <footer className="autopilot-batch-hud__actions">
          <button
            type="button"
            className="autopilot-batch-hud__btn autopilot-batch-hud__btn--reject"
            onClick={rejectAll}
          >
            Reject all
          </button>
          <div className="autopilot-batch-hud__spacer" />
          <button
            type="button"
            className="autopilot-batch-hud__btn autopilot-batch-hud__btn--ghost"
            onClick={done}
          >
            Done — defer undecided
          </button>
          <button
            type="button"
            className="autopilot-batch-hud__btn autopilot-batch-hud__btn--accept"
            onClick={acceptAll}
          >
            ✓ Accept all
          </button>
        </footer>
      </div>
    </div>
  );
}

function BatchRow({
  item,
  state,
  onPatch,
}: {
  item: BatchRequest['items'][number];
  state: RowState;
  onPatch: (p: Partial<RowState>) => void;
}) {
  const [contextOpen, setContextOpen] = useState(false);
  const decidedClass = state.decision
    ? ` autopilot-batch-row--${state.decision}`
    : '';
  return (
    <article className={`autopilot-batch-row${decidedClass}`}>
      <div className="autopilot-batch-row__preview">
        {item.preview.map((cell, i) => (
          <span className="autopilot-batch-row__cell" key={i}>
            <span className="autopilot-batch-row__cell-label">{cell.label}</span>
            <span className="autopilot-batch-row__cell-value">{cell.value}</span>
          </span>
        ))}
        {item.verdict && (
          <span
            className={`autopilot-batch-row__verdict autopilot-batch-row__verdict--${item.verdict}`}
            title={`Proposed verdict: ${item.verdict}`}
          >
            {item.verdict}
          </span>
        )}
      </div>
      <div className="autopilot-batch-row__draft">
        <span className="autopilot-batch-row__draft-label">Draft</span>
        <textarea
          className="autopilot-batch-row__draft-body"
          value={state.editedDraft}
          onChange={(e) => onPatch({ editedDraft: e.target.value })}
          rows={3}
          spellCheck
          disabled={state.decision === 'accept' || state.decision === 'reject'}
        />
      </div>
      {item.context && (
        <div className="autopilot-batch-row__context">
          <button
            type="button"
            className="autopilot-batch-row__context-toggle"
            onClick={() => setContextOpen((v) => !v)}
          >
            {contextOpen ? '▾ Hide context' : '▸ Show context'}
          </button>
          {contextOpen && (
            <pre className="autopilot-batch-row__context-body">{item.context}</pre>
          )}
        </div>
      )}
      {state.feedbackOpen && (
        <div className="autopilot-batch-row__feedback">
          <textarea
            className="autopilot-batch-row__feedback-input"
            value={state.feedback}
            onChange={(e) => onPatch({ feedback: e.target.value })}
            placeholder="Why rejecting? (stored for next time)"
            rows={2}
            autoFocus
          />
        </div>
      )}
      <div className="autopilot-batch-row__actions">
        {state.decision ? (
          <>
            <span className="autopilot-batch-row__status">
              {state.decision === 'accept'
                ? '✓ accepted'
                : state.decision === 'reject'
                  ? '✕ rejected'
                  : 'skipped'}
            </span>
            <button
              type="button"
              className="autopilot-batch-row__btn autopilot-batch-row__btn--ghost"
              onClick={() =>
                onPatch({ decision: undefined, feedbackOpen: false })
              }
            >
              Undo
            </button>
          </>
        ) : state.feedbackOpen ? (
          <>
            <button
              type="button"
              className="autopilot-batch-row__btn autopilot-batch-row__btn--ghost"
              onClick={() => onPatch({ feedbackOpen: false, feedback: '' })}
            >
              Cancel
            </button>
            <button
              type="button"
              className="autopilot-batch-row__btn autopilot-batch-row__btn--reject"
              onClick={() =>
                onPatch({
                  decision: 'reject',
                  feedbackOpen: false,
                })
              }
              disabled={state.feedback.trim().length === 0}
            >
              Reject with note
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="autopilot-batch-row__btn autopilot-batch-row__btn--ghost"
              onClick={() => onPatch({ decision: 'reject' })}
            >
              Reject
            </button>
            <button
              type="button"
              className="autopilot-batch-row__btn autopilot-batch-row__btn--ghost"
              onClick={() => onPatch({ feedbackOpen: true })}
            >
              Reject + note
            </button>
            <button
              type="button"
              className="autopilot-batch-row__btn autopilot-batch-row__btn--accept"
              onClick={() => onPatch({ decision: 'accept' })}
            >
              ✓ Accept
            </button>
          </>
        )}
      </div>
    </article>
  );
}
