import { fromPromise } from 'xstate';

import type { InboxItem } from '@shared/types';

import type { NodeHandlerInput } from './types.js';

/**
 * Write the previous step's output into the Inbox under a named
 * source. Always the last node in inbox-feeding workflows.
 *
 * Expects `prev` to be `InboxItem[]` (the transform node usually
 * produces this from the API response). Items missing required
 * fields are dropped silently — keeps a single malformed item from
 * blanking the whole inbox.
 *
 * Params:
 *   {
 *     source: string         // bucket name (matches InboxItem.source)
 *     label: string          // section header in the Inbox tab
 *   }
 *
 * Output: pass-through of the items written, so a downstream node
 * (e.g. notify) can see what just landed.
 */

interface InboxWriteParams {
  source: string;
  label: string;
}

function isItem(v: unknown): v is InboxItem {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    typeof r.title === 'string' &&
    typeof r.createdAt === 'number'
  );
}

export const inboxWriteNode = fromPromise<
  InboxItem[],
  NodeHandlerInput<InboxWriteParams>
>(async ({ input }) => {
  const { params, prev, ctx } = input;
  if (!params.source) throw new Error('inbox-write: params.source required');
  if (!params.label) throw new Error('inbox-write: params.label required');
  if (!Array.isArray(prev)) {
    throw new Error(
      `inbox-write: expected an array from previous step, got ${typeof prev}`,
    );
  }
  // Stamp the source if a transform forgot it, drop malformed rows.
  const items: InboxItem[] = [];
  for (const raw of prev) {
    if (!isItem(raw)) continue;
    items.push({ ...raw, source: raw.source || params.source });
  }
  ctx.inbox.setExternalItems(params.source, params.label, items);
  return items;
});
