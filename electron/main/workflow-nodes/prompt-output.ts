import { fromPromise } from 'xstate';

import { approvalBridge } from '../autopilot/approval-bridge.js';
import { appendFeedback } from '../autopilot/feedback-store.js';
import { notifier } from '../notifier.js';

import type { NodeHandlerInput } from './types.js';

/**
 * Autopilot interruption node. Pauses the pipeline, opens an
 * approval HUD with the previous step's output, and resolves based
 * on the user's decision:
 *
 *   - **Accept** (optionally with an edit): pipeline continues with
 *     either the original `prev` (default) or the user's edited body
 *     (`onAccept: 'feedback'`) as the next step's input. The
 *     decision is appended to the workflow's feedback file as an
 *     `ACCEPTED` entry so the next run sees what the user blessed.
 *   - **Reject** (optionally with a free-text note): throws to error
 *     the pipeline. The feedback file gets a `REJECTED` entry +
 *     the note so the next run's `run-skill {feedback}` substitution
 *     shows the agent what to change.
 *
 * Params:
 *   {
 *     title: string;          // modal heading
 *     summary?: string;       // notification + modal one-liner
 *     body?: string;          // override body shown to the user;
 *                             //   defaults to stringified `prev`
 *     context?: string;       // read-only context (thread, PR diff,
 *                             //   etc.) shown alongside the draft
 *     onAccept?: 'prev' | 'feedback'; // default 'prev'
 *   }
 *
 * Output: `prev` (or the user's edit if `onAccept: 'feedback'`).
 * Throws on reject; the run ends with status `errored`.
 */

interface PromptOutputParams {
  title: string;
  summary?: string;
  body?: string;
  context?: string;
  onAccept?: 'prev' | 'feedback';
}

export const promptOutputNode = fromPromise<
  unknown,
  NodeHandlerInput<PromptOutputParams>
>(async ({ input, signal }) => {
  const { params, prev, ctx } = input;
  if (!params.title || typeof params.title !== 'string') {
    throw new Error('prompt-output: params.title is required');
  }
  const workflowId = ctx.workflowId ?? 'autopilot';
  const body = params.body ?? stringify(prev);

  // Fire a notification so the user notices the prompt even if the
  // Jarvis window isn't focused. NOT in AUTO_SOURCES; this fires
  // regardless of mode. Clicking the notification just brings the
  // app forward — the HUD itself opens immediately via the
  // broadcast triggered by approvalBridge.await().
  notifier.post({
    source: 'autopilot-prompt',
    title: params.title,
    body: params.summary ?? body.slice(0, 160),
  });

  // Surface mid-pipeline cancellation. `signal` is threaded into the
  // bridge so an aborted workflow run drops the pending entry +
  // rejects this promise cleanly — no stale bridge entries left
  // around when the user hits Stop.
  const decision = await approvalBridge.await(
    {
      title: params.title,
      summary: params.summary,
      body,
      context: params.context,
      workflowId,
    },
    signal,
  );

  if (decision.decision === 'accept') {
    appendFeedback(workflowId, {
      decision: 'ACCEPTED',
      context: params.summary,
      drafted: body,
      ...(decision.editedBody && decision.editedBody !== body
        ? { feedback: `User edited before accepting: "${decision.editedBody}"` }
        : {}),
    });
    if (params.onAccept === 'feedback' && decision.editedBody) {
      return decision.editedBody;
    }
    return prev;
  }

  // Reject path — append the note + throw.
  appendFeedback(workflowId, {
    decision: 'REJECTED',
    context: params.summary,
    drafted: body,
    feedback: decision.feedback ?? '(no note)',
  });
  throw new Error(
    `prompt-output: rejected${decision.feedback ? ` — ${decision.feedback}` : ''}`,
  );
});

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
