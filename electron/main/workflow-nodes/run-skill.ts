import { fromPromise } from 'xstate';

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
 *     includePrev?: boolean  // default true; appends prev to prompt as JSON
 *     timeoutMs?: number     // default 5 min
 *   }
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
  const includePrev = params.includePrev !== false;
  const prevBlock =
    includePrev && prev !== undefined
      ? `\n\nContext from prior step:\n\`\`\`json\n${JSON.stringify(prev, null, 2)}\n\`\`\``
      : '';
  const prompt = `${promptBase}${prevBlock}`.trim() || 'Run.';

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
