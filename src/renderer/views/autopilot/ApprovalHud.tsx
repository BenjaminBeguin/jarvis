import { useEffect, useState } from 'react';

/**
 * Renderer modal for the autopilot `prompt-output` workflow node.
 *
 * Subscribes to `autopilotApprovalRequested` from main; when one
 * arrives it pushes onto a queue and renders the head of the queue
 * as a centered modal over whatever the user was doing. One request
 * at a time — if a second one fires while the first is open, it
 * waits. The user clicks Accept / Reject / Reject + note; the
 * decision flies back to main via the bridge and the next queued
 * request (if any) takes the modal.
 *
 * Editing the body before Accept is captured as `editedBody`. The
 * prompt-output node's `onAccept: 'feedback'` mode passes the
 * edited body forward into the pipeline; default mode treats the
 * edit as a positive feedback signal and continues with the
 * original `prev`.
 */

interface Request {
  requestId: string;
  workflowId: string;
  title: string;
  summary?: string;
  body?: string;
  context?: string;
}

export function ApprovalHud() {
  const [queue, setQueue] = useState<Request[]>([]);
  const [draftBody, setDraftBody] = useState<string>('');
  const [feedbackOpen, setFeedbackOpen] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<string>('');

  // Subscribe to incoming requests. Push to queue; head renders.
  useEffect(() => {
    const off = window.jarvis.onAutopilotApprovalRequested((req) => {
      setQueue((prev) => [...prev, req]);
    });
    return off;
  }, []);

  // When the head of the queue changes, reset the body draft + feedback.
  const head = queue[0] ?? null;
  useEffect(() => {
    if (!head) return;
    setDraftBody(head.body ?? '');
    setFeedbackOpen(false);
    setFeedback('');
  }, [head?.requestId]);

  if (!head) return null;

  const accept = (): void => {
    const edited = draftBody !== (head.body ?? '') ? draftBody : undefined;
    void window.jarvis.autopilotApprove(head.requestId, edited);
    setQueue((prev) => prev.slice(1));
  };

  const reject = (note?: string): void => {
    void window.jarvis.autopilotReject(head.requestId, note);
    setQueue((prev) => prev.slice(1));
  };

  return (
    <div className="autopilot-hud" role="dialog" aria-modal="true">
      <div className="autopilot-hud__card">
        <header className="autopilot-hud__head">
          <span className="autopilot-hud__glyph">⚡</span>
          <span className="autopilot-hud__title">{head.title}</span>
          {queue.length > 1 && (
            <span className="autopilot-hud__queue">
              +{queue.length - 1} more
            </span>
          )}
        </header>
        {head.summary && (
          <div className="autopilot-hud__summary">{head.summary}</div>
        )}
        {head.context && (
          <div className="autopilot-hud__context">
            <span className="autopilot-hud__label">Context</span>
            <pre className="autopilot-hud__context-body">{head.context}</pre>
          </div>
        )}
        <div className="autopilot-hud__draft">
          <label
            htmlFor="autopilot-hud__body"
            className="autopilot-hud__label"
          >
            Draft <span className="autopilot-hud__hint">(edit before accepting)</span>
          </label>
          <textarea
            id="autopilot-hud__body"
            className="autopilot-hud__body"
            value={draftBody}
            onChange={(e) => setDraftBody(e.target.value)}
            rows={8}
            spellCheck
          />
        </div>
        {feedbackOpen && (
          <div className="autopilot-hud__feedback">
            <label
              htmlFor="autopilot-hud__feedback"
              className="autopilot-hud__label"
            >
              Why are you rejecting? <span className="autopilot-hud__hint">(stored for next time)</span>
            </label>
            <textarea
              id="autopilot-hud__feedback"
              className="autopilot-hud__feedback-input"
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              rows={3}
              placeholder="too formal · drop the hedging · prefer shorter · etc."
              autoFocus
            />
          </div>
        )}
        <footer className="autopilot-hud__actions">
          {feedbackOpen ? (
            <>
              <button
                type="button"
                className="autopilot-hud__btn autopilot-hud__btn--ghost"
                onClick={() => {
                  setFeedbackOpen(false);
                  setFeedback('');
                }}
              >
                Back
              </button>
              <div className="autopilot-hud__spacer" />
              <button
                type="button"
                className="autopilot-hud__btn autopilot-hud__btn--reject"
                onClick={() => reject(feedback.trim() || undefined)}
                disabled={feedback.trim().length === 0}
              >
                Reject with note
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="autopilot-hud__btn autopilot-hud__btn--ghost"
                onClick={() => reject()}
              >
                Reject
              </button>
              <button
                type="button"
                className="autopilot-hud__btn autopilot-hud__btn--ghost"
                onClick={() => setFeedbackOpen(true)}
              >
                Reject + note
              </button>
              <div className="autopilot-hud__spacer" />
              <button
                type="button"
                className="autopilot-hud__btn autopilot-hud__btn--accept"
                onClick={accept}
              >
                ✓ Accept
              </button>
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
