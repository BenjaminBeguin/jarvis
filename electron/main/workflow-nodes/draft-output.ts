import { fromPromise } from 'xstate';

import type { InboxItem } from '@shared/types';

import type { NodeHandlerInput } from './types.js';

/**
 * Autopilot draft-output node. The silent variant of an autopilot
 * pipeline's terminal step: takes the previous step's output and
 * writes it as an InboxItem under the `autopilot-drafts` source for
 * the user to review later.
 *
 * Params:
 *   {
 *     title: string;          // shown as the Inbox row title.
 *                             // Supports `{prev}` substitution (the
 *                             // raw previous output, stringified) and
 *                             // `{prev.<field>}` for object props.
 *     source?: string;        // override the bucket. Defaults to
 *                             // 'autopilot-drafts' — pick a custom
 *                             // name when you want a separate Inbox
 *                             // section (e.g. 'autopilot-pr-reviews').
 *     subtitle?: string;      // optional one-liner; same substitution
 *                             // rules as `title`.
 *   }
 *
 * The previous step's full output becomes the InboxItem's `body`
 * field (stringified for non-string values). Output: pass-through of
 * the InboxItem so a downstream `notify` step could ping the user.
 */

interface DraftOutputParams {
  title: string;
  subtitle?: string;
  source?: string;
}

const DEFAULT_SOURCE = 'autopilot-drafts';

export const draftOutputNode = fromPromise<
  InboxItem,
  NodeHandlerInput<DraftOutputParams>
>(async ({ input }) => {
  const { params, prev, ctx } = input;
  if (!params.title || typeof params.title !== 'string') {
    throw new Error('draft-output: params.title is required');
  }
  const source = params.source ?? DEFAULT_SOURCE;
  // Fall back to a placeholder when the agent step emitted no text —
  // we always want SOMETHING in body so the Inbox row's "Show
  // content" toggle renders. An empty body would be a dead-end UI.
  const body =
    stringifyForBody(prev) ||
    '(The previous step produced no text. Open the run in the Latest run dock to inspect the step outputs.)';
  const title = substitute(params.title, prev);
  const subtitle = params.subtitle
    ? substitute(params.subtitle, prev)
    : undefined;
  // Build a stable id from the workflow id + timestamp. Multiple drafts
  // from the same workflow accumulate; the user dismisses each
  // manually from the Inbox.
  const workflowId = ctx.workflowId ?? 'autopilot';
  const id = `${source}-${workflowId}-${Date.now()}`;
  const item: InboxItem = {
    id,
    source,
    title: title.slice(0, 280),
    ...(subtitle ? { subtitle: subtitle.slice(0, 280) } : {}),
    body,
    createdAt: Date.now(),
  };
  // Read existing drafts so a new run doesn't clobber prior unreviewed
  // ones. setExternalItems replaces the section wholesale.
  const existing = ctx.inbox
    .list()
    .filter((it) => it.source === source);
  ctx.inbox.setExternalItems(
    source,
    sourceLabel(source),
    [item, ...existing].slice(0, 50),
  );
  return item;
});

function sourceLabel(source: string): string {
  if (source === DEFAULT_SOURCE) return 'Autopilot drafts';
  // Convert 'autopilot-pr-reviews' → 'Autopilot · pr reviews'.
  const tail = source.replace(/^autopilot-?/, '').replace(/-/g, ' ');
  return tail ? `Autopilot · ${tail}` : 'Autopilot drafts';
}

function stringifyForBody(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * Resolve `{prev}` and `{prev.<field>}` tokens against the previous
 * step's output. Non-matching tokens are left literal so a typo'd
 * field is visible rather than silently empty.
 */
function substitute(template: string, prev: unknown): string {
  return template.replace(/\{prev(?:\.([\w.]+))?\}/g, (_match, path) => {
    if (!path) return stringifyForBody(prev);
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
    return stringifyForBody(cur);
  });
}
