import { fromPromise } from 'xstate';

import { approvalBridge } from '../autopilot/approval-bridge.js';
import { appendFeedback } from '../autopilot/feedback-store.js';
import { notifier } from '../notifier.js';
import type { BatchDecision, BatchItem } from '@shared/types';

import type { NodeHandlerInput } from './types.js';

/**
 * Batch variant of `prompt-output`. Takes an array (either
 * `BatchItem[]` directly, or arbitrary data mapped via the `rowsFn`
 * template) and opens a multi-row HUD with per-row Accept / Reject
 * controls. The pipeline blocks until the user clicks Done (or
 * decides every row).
 *
 * Use this when an autopilot scenario discovers more than one
 * thing to triage in a single tick — multiple unread Slack DMs,
 * several PRs in the review queue, several comments on one PR.
 * The user decides them in one session instead of clicking through
 * N stacked single-item HUDs.
 *
 * Params:
 *   {
 *     title: string;
 *     summary?: string;
 *     // JS expression mapping `$` (prev) → BatchItem[]. Default
 *     // assumes `$` is already BatchItem[]. Use this when the
 *     // agent emits arbitrary JSON and you want to shape it for
 *     // the HUD.
 *     rowsFn?: string;
 *     // What to do when the array is empty after rowsFn. 'skip'
 *     // (default) completes the run silently with status
 *     // 'completed' and no HUD. 'notify' posts a notification.
 *     onEmpty?: 'skip' | 'notify';
 *   }
 *
 * Output: `{ accepted: BatchItem[], rejected: BatchItem[] }`. The
 * `rejected` array carries each rejection's freeform feedback note
 * on a `feedback` field if the user supplied one.
 */

interface BatchPromptParams {
  title: string;
  summary?: string;
  rowsFn?: string;
  onEmpty?: 'skip' | 'notify';
}

interface BatchPromptResult {
  accepted: Array<BatchItem & { editedDraft?: string }>;
  rejected: Array<BatchItem & { feedback?: string }>;
}

function isBatchItem(v: unknown): v is BatchItem {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === 'string' &&
    Array.isArray(r.preview) &&
    typeof r.draft === 'string'
  );
}

export const batchPromptOutputNode = fromPromise<
  BatchPromptResult,
  NodeHandlerInput<BatchPromptParams>
>(async ({ input, signal }) => {
  const { params, prev, ctx } = input;
  if (!params.title || typeof params.title !== 'string') {
    throw new Error('batch-prompt-output: params.title is required');
  }
  const workflowId = ctx.workflowId ?? 'autopilot';

  // Map prev → BatchItem[] via rowsFn template (or assume prev is
  // already in shape).
  let rows: BatchItem[] = [];
  if (params.rowsFn && params.rowsFn.trim()) {
    let mapper: (dollar: unknown) => unknown;
    try {
      mapper = new Function('$', `return (${params.rowsFn})`) as (
        d: unknown,
      ) => unknown;
    } catch (err) {
      throw new Error(
        `batch-prompt-output: rowsFn failed to compile — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    let mapped: unknown;
    try {
      mapped = mapper(prev);
    } catch (err) {
      throw new Error(
        `batch-prompt-output: rowsFn threw — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!Array.isArray(mapped)) {
      throw new Error(
        `batch-prompt-output: rowsFn returned ${typeof mapped}, expected array`,
      );
    }
    rows = mapped.filter(isBatchItem);
  } else if (Array.isArray(prev)) {
    rows = (prev as unknown[]).filter(isBatchItem);
  } else {
    throw new Error(
      'batch-prompt-output: prev is not an array and no rowsFn provided',
    );
  }

  // Empty-batch handling. The default 'skip' is what most autopilot
  // scenarios want: cron ticked, found nothing, end the run quietly.
  if (rows.length === 0) {
    if ((params.onEmpty ?? 'skip') === 'notify') {
      notifier.post({
        source: 'autopilot-prompt',
        title: params.title,
        body: 'No items to review.',
      });
    }
    return { accepted: [], rejected: [] };
  }

  // Surface the batch via a notification so the user sees it even
  // when the Jarvis window isn't focused.
  notifier.post({
    source: 'autopilot-prompt',
    title: params.title,
    body:
      params.summary ?? `${rows.length} draft${rows.length === 1 ? '' : 's'} to review`,
  });

  const decisions = await approvalBridge.awaitBatch(
    {
      title: params.title,
      summary: params.summary,
      items: rows,
      workflowId,
    },
    signal,
  );

  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const result: BatchPromptResult = { accepted: [], rejected: [] };
  for (const d of decisions) {
    const row = byId.get(d.rowId);
    if (!row) continue;
    if (d.decision === 'accept') {
      const accepted = { ...row, editedDraft: d.editedDraft ?? undefined };
      result.accepted.push(accepted);
      appendFeedback(workflowId, {
        decision: 'ACCEPTED',
        context: rowContextLabel(row),
        drafted: d.editedDraft ?? row.draft,
        ...(d.editedDraft && d.editedDraft !== row.draft
          ? { feedback: `User edited before accepting: "${d.editedDraft}"` }
          : {}),
      });
    } else if (d.decision === 'reject') {
      const rejected = { ...row, feedback: d.feedback };
      result.rejected.push(rejected);
      appendFeedback(workflowId, {
        decision: 'REJECTED',
        context: rowContextLabel(row),
        drafted: row.draft,
        feedback: d.feedback ?? '(no note)',
      });
    }
    // 'skip' leaves the row out of both buckets and writes no
    // feedback — the next tick re-discovers it.
  }
  return result;
});

/** Short identity label for a row, used as the feedback file's
 *  `**Context**` line. Pulls from the row's preview cells so the
 *  log stays readable when you scan the file later. */
function rowContextLabel(row: BatchItem): string {
  const head = row.preview
    .slice(0, 2)
    .map((p) => `${p.label}: ${p.value}`)
    .join(' · ');
  return `batch row \`${row.id}\`${head ? ` · ${head}` : ''}`;
}
