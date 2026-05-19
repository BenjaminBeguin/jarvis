import { fromPromise } from 'xstate';

import { readFeedback } from '../autopilot/feedback-store.js';
import { awaitTurnResult } from '../await-turn.js';
import type { NodeHandlerInput } from './types.js';

/**
 * Launch a Claude task using a named skill, with the previous step's
 * output included in the prompt. The bridge from workflow plumbing
 * to agentic work.
 *
 * Params:
 *   {
 *     skillId: string
 *     prompt?: string        // user message; default empty
 *                            //   supports {prev} and {feedback}
 *                            //   substitution (see below)
 *     includePrev?: boolean  // default true; appends prev to prompt as JSON
 *                            //   IFF no {prev} token is present in the
 *                            //   template — explicit token wins
 *     timeoutMs?: number     // default 5 min
 *   }
 *
 * Prompt substitution tokens (resolved before the Claude turn):
 *
 *   {prev}       → JSON.stringify of the previous step's output
 *   {prev.x.y}   → dotted-path access into prev (string-coerced)
 *   {feedback}   → contents of the autopilot feedback file for this
 *                  workflow (~/.jarvis/autopilot/feedback/<id>.md);
 *                  empty string if the file doesn't exist yet.
 *                  Autopilot scenarios include this token so the
 *                  agent sees what the user accepted / rejected /
 *                  noted last time. Compound improvement loop.
 *
 * Output: the agent's final assistant text (string).
 */

interface RunSkillParams {
  skillId: string;
  prompt?: string;
  includePrev?: boolean;
  timeoutMs?: number;
}

export const runSkillNode = fromPromise<
  string,
  NodeHandlerInput<RunSkillParams>
>(async ({ input, signal }) => {
  const { params, prev, ctx } = input;
  if (!params.skillId) throw new Error('run-skill: params.skillId required');

  const promptBase = params.prompt ?? '';
  const hasPrevToken = /\{prev(?:\.[\w.]+)?\}/.test(promptBase);
  const hasFeedbackToken = /\{feedback\}/.test(promptBase);
  // Resolve {feedback} lazily — only read the file if the template
  // references it. Empty string when there's no workflowId on ctx
  // (extremely rare — runner now always sets it).
  const feedback = hasFeedbackToken && ctx.workflowId
    ? readFeedback(ctx.workflowId)
    : '';
  const resolved = substitute(promptBase, prev, feedback);
  // Only append the legacy JSON block when the template DIDN'T
  // explicitly reference {prev}. That way old workflows keep
  // working unchanged, but new ones that interpolate prev inline
  // don't get a duplicate dump tacked on the end.
  const includePrev = params.includePrev !== false && !hasPrevToken;
  const prevBlock =
    includePrev && prev !== undefined
      ? `\n\nContext from prior step:\n\`\`\`json\n${JSON.stringify(prev, null, 2)}\n\`\`\``
      : '';
  const prompt = `${resolved}${prevBlock}`.trim() || 'Run.';

  const task = ctx.runner.launch({
    skillId: params.skillId,
    prompt,
    origin: 'api',
    unattended: true,
  });

  // Abort the task if XState stops the actor (user clicked Stop).
  const onAbort = (): void => {
    try {
      void ctx.runner.abort(task.id);
    } catch {
      // already gone
    }
  };
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const turn = await awaitTurnResult(ctx.runner, task.id, {
      timeoutMs: params.timeoutMs ?? 5 * 60_000,
    });
    if (turn.status === 'errored' || turn.status === 'aborted') {
      throw new Error(
        `run-skill: task ${turn.status}${turn.finalText ? ` — ${turn.finalText.slice(0, 200)}` : ''}`,
      );
    }
    return turn.finalText ?? '';
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
});

/**
 * Resolve {prev}, {prev.<field>}, and {feedback} tokens in a prompt
 * template. Unknown tokens are left literal so a typo'd field is
 * obvious in the agent's input. Cheap — single regex sweep.
 */
function substitute(template: string, prev: unknown, feedback: string): string {
  // {feedback} first — independent of prev. Empty string when the
  // feedback file doesn't exist yet, which Claude handles cleanly.
  let out = template.replace(/\{feedback\}/g, feedback);
  out = out.replace(/\{prev(?:\.([\w.]+))?\}/g, (_match, path) => {
    if (!path) return stringifyForPrompt(prev);
    const segments = String(path).split('.');
    let cur: unknown = prev;
    for (const seg of segments) {
      if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
        cur = (cur as Record<string, unknown>)[seg];
      } else {
        return `{prev.${path}}`;
      }
    }
    if (typeof cur === 'string') return cur;
    return stringifyForPrompt(cur);
  });
  return out;
}

function stringifyForPrompt(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}
