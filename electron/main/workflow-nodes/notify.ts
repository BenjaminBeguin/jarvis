import { fromPromise } from 'xstate';

import type { NodeHandlerInput } from './types.js';

/**
 * Fire a macOS notification (also fans out to Telegram bot etc. via
 * the notifier subscriber list).
 *
 * Params:
 *   {
 *     title: string
 *     body?: string                  // default: empty
 *     source?: string                // default: 'notify-tool'
 *     silent?: boolean
 *   }
 *
 * Output: pass-through of `prev` so notify can sit mid-pipeline
 * ("fetch → notify → transform" works).
 */

interface NotifyParams {
  title: string;
  body?: string;
  source?: string;
  silent?: boolean;
}

export const notifyNode = fromPromise<unknown, NodeHandlerInput<NotifyParams>>(
  async ({ input }) => {
    const { params, prev, ctx } = input;
    if (!params.title) throw new Error('notify: params.title required');
    ctx.notifier.post({
      // Default source — 'notify-tool' is the closest match to "a workflow
      // step asked for a notification." Users can override for proper
      // Telegram filter routing.
      source: (params.source as 'notify-tool') ?? 'notify-tool',
      title: params.title,
      body: params.body ?? '',
      silent: !!params.silent,
    });
    return prev;
  },
);
