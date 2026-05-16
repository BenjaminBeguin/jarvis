import type { TaskEvent, TaskStatus, TaskSummary } from '@shared/types';

import type { TaskRunner } from './task-runner.js';

export interface TurnResult {
  status: TaskStatus;
  /** Aggregated assistant text for this turn, or null if no text was
   *  produced (e.g. the task aborted before any assistant message). */
  finalText: string | null;
  /** True if the task is paused waiting for the next user message
   *  (multi-turn point). False if the task is fully done. */
  awaitingInput: boolean;
  costUsd: number;
}

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * Resolve when the current SDK turn of `taskId` produces a `result`
 * message — that's the marker that the model has finished its reply for
 * this user message and is ready for the next input. Aggregates assistant
 * text along the way. Also resolves on terminal statuses (errored,
 * aborted) so callers never hang on a failed task.
 *
 * Does NOT wait for `status='completed'` — see CLAUDE.md "two primitives"
 * and the plan in ~/.claude/plans/later-i-want-to-giggly-starfish.md.
 * In multi-turn shapes the task stays `running + awaitingInput=true` after
 * each turn so the SDK session can be resumed by sendMessage.
 */
export function awaitTurnResult(
  runner: TaskRunner,
  taskId: string,
  opts: { timeoutMs?: number } = {},
): Promise<TurnResult> {
  return new Promise((resolve, reject) => {
    let assistantText = '';
    let lastCost = 0;
    let resultSeen = false;
    let settled = false;

    const cleanup = (): void => {
      runner.off('event', onEvent);
      runner.off('status', onStatus);
      clearTimeout(timer);
    };

    const settle = (result: TurnResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };

    const onEvent = (payload: { taskId: string; event: TaskEvent }): void => {
      if (payload.taskId !== taskId) return;
      const msg = payload.event.msg as {
        type?: string;
        message?: { content?: unknown[] };
        total_cost_usd?: number;
      };
      if (msg.type === 'assistant' && Array.isArray(msg.message?.content)) {
        for (const block of msg.message.content) {
          if (
            block &&
            typeof block === 'object' &&
            (block as { type?: string }).type === 'text' &&
            typeof (block as { text?: unknown }).text === 'string'
          ) {
            assistantText += (block as { text: string }).text;
          }
        }
      }
      if (msg.type === 'result') {
        if (typeof msg.total_cost_usd === 'number') lastCost = msg.total_cost_usd;
        resultSeen = true;
      }
    };

    const onStatus = (summary: TaskSummary): void => {
      if (summary.id !== taskId) return;
      // Terminal failure paths — resolve immediately so the caller can
      // surface the failure to the user instead of hanging.
      if (summary.status === 'errored' || summary.status === 'aborted') {
        settle({
          status: summary.status,
          finalText: assistantText || null,
          awaitingInput: false,
          costUsd: summary.costUsd ?? lastCost,
        });
        return;
      }
      // Happy path: the SDK fired a result event, then the runner
      // emitted the status update we just received. awaitingInput is
      // now reliable and the cost is final for this turn.
      if (resultSeen) {
        settle({
          status: summary.status,
          finalText: assistantText || null,
          awaitingInput: !!summary.awaitingInput,
          costUsd: summary.costUsd ?? lastCost,
        });
      }
    };

    runner.on('event', onEvent);
    runner.on('status', onStatus);

    const timer = setTimeout(() => {
      fail(new Error(`awaitTurnResult timed out after ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  });
}
