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
 *     skipPattern?: string;   // regex source; if `prev` matches,
 *                             //   short-circuit without opening
 *                             //   the HUD. Default '^\\(skip\\)$'.
 *   }
 *
 * Templating: title / summary / body / context all support
 * `{prev}`, `{prev.field}`, and `{seed.field}` substitution. Use
 * `{seed.…}` to surface the original trigger payload (e.g. the
 * Slack item that fired an inbox-changed scenario) alongside the
 * draft so the user has context for their decision.
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
  skipPattern?: string;
}

const DEFAULT_SKIP_PATTERN = '^\\(skip\\)$';

export const promptOutputNode = fromPromise<
  unknown,
  NodeHandlerInput<PromptOutputParams>
>(async ({ input, signal }) => {
  const { params, prev, ctx } = input;
  if (!params.title || typeof params.title !== 'string') {
    throw new Error('prompt-output: params.title is required');
  }
  const workflowId = ctx.workflowId ?? 'autopilot';
  const seed = ctx.seed;

  // Skip short-circuit. If `prev` matches the skip pattern (default
  // "(skip)" — what the slack-dm-ack skill emits when it doesn't
  // want to draft) we end the run as a clean error without
  // bothering the user. The feedback file records it so the agent
  // sees its prior skips on the next run.
  const skipRe = new RegExp(params.skipPattern ?? DEFAULT_SKIP_PATTERN);
  if (typeof prev === 'string' && skipRe.test(prev.trim())) {
    appendFeedback(workflowId, {
      decision: 'REJECTED',
      context: 'agent declined to draft',
      drafted: prev,
      feedback: 'auto-skipped (matched skipPattern)',
    });
    throw new Error('prompt-output: skipped (agent declined to draft)');
  }

  const body = substitute(params.body ?? stringify(prev), prev, seed);
  const title = substitute(params.title, prev, seed);
  const summary = params.summary
    ? substitute(params.summary, prev, seed)
    : undefined;
  const context = params.context
    ? substitute(params.context, prev, seed)
    : undefined;

  // Fire a notification so the user notices the prompt even if the
  // Jarvis window isn't focused. NOT in AUTO_SOURCES; this fires
  // regardless of mode. Clicking the notification just brings the
  // app forward — the HUD itself opens immediately via the
  // broadcast triggered by approvalBridge.await().
  notifier.post({
    source: 'autopilot-prompt',
    title,
    body: summary ?? body.slice(0, 160),
  });

  // Surface mid-pipeline cancellation. `signal` is threaded into the
  // bridge so an aborted workflow run drops the pending entry +
  // rejects this promise cleanly — no stale bridge entries left
  // around when the user hits Stop.
  const decision = await approvalBridge.await(
    {
      title,
      summary,
      body,
      context,
      workflowId,
    },
    signal,
  );

  if (decision.decision === 'accept') {
    appendFeedback(workflowId, {
      decision: 'ACCEPTED',
      context: summary,
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
    context: summary,
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

/**
 * Resolve `{prev}`, `{prev.<path>}`, and `{seed.<path>}` tokens in
 * one of prompt-output's text params. Mirror of the substitution
 * helpers in run-skill and draft-output — kept inline so each node
 * can evolve independently without coupling on a shared module
 * that'd grow unbounded.
 */
function substitute(template: string, prev: unknown, seed: unknown): string {
  let out = template.replace(
    /\{(prev|seed)(?:\.([\w.]+))?\}/g,
    (_match, kind, path) => {
      const source = kind === 'seed' ? seed : prev;
      if (!path) return stringify(source);
      const segments = String(path).split('.');
      let cur: unknown = source;
      for (const seg of segments) {
        if (
          cur &&
          typeof cur === 'object' &&
          seg in (cur as Record<string, unknown>)
        ) {
          cur = (cur as Record<string, unknown>)[seg];
        } else {
          return `{${kind}.${path}}`;
        }
      }
      if (typeof cur === 'string') return cur;
      return stringify(cur);
    },
  );
  return out;
}
