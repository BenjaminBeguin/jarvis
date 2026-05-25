import { fromPromise } from 'xstate';

import type { Draft, DraftAction, NewDraft, SendAction } from '@shared/types';

import type { NodeHandlerInput } from './types.js';

/**
 * Append-only writer for the AI Drafts store. Any triage/autopilot
 * workflow whose final output is "drafts the user should review" ends
 * with this node — Gmail triage, Slack triage, social DMs, PR comment
 * drafts. The renderer then shows everything in one Drafts view;
 * per-channel + per-action dispatch lives in each row's
 * `actions[].sendAction`.
 *
 * Params:
 *   {
 *     source: string;   // producer id ('gmail-triage', 'slack-triage', …)
 *   }
 *
 * Input (prev): an array of draft objects shaped for `NewDraft`:
 *   {
 *     sourceItemId?: string,
 *     channel: string,
 *     title: string,
 *     contextSummary?: string,
 *     contextFull?: string,
 *     body: string,             // default body for actions that need one
 *     why?: string,
 *     actions: Array<{
 *       id: string,
 *       label: string,
 *       primary?: boolean,
 *       requiresBody?: boolean,
 *       sendAction: { ... }
 *     }>
 *   }
 *
 * Backwards compat: if the skill emits the legacy { intent,
 * sendAction } pair INSTEAD of actions[], the node synthesizes a
 * single-action list so old skills keep working.
 *
 * Dedup: if a draft for `(source, sourceItemId)` already exists, the
 * store returns the existing row instead of inserting a duplicate.
 *
 * Output: the created/existing Draft[] (passthrough so a downstream
 * `notify` node can mention "N new drafts").
 */

interface DraftStoreWriteParams {
  source: string;
}

interface IncomingDraft {
  sourceItemId?: string | null;
  intent?: unknown;
  channel?: unknown;
  title?: unknown;
  contextSummary?: unknown;
  contextFull?: unknown;
  body?: unknown;
  why?: unknown;
  // New shape
  actions?: unknown;
  // Legacy shape (still accepted for backwards compat)
  sendAction?: unknown;
}

function isSendAction(v: unknown): v is SendAction {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (r.kind === 'shell') {
    return typeof r.cmd === 'string' && Array.isArray(r.args);
  }
  return (
    typeof r.mcp === 'string' &&
    typeof r.tool === 'string' &&
    r.args !== null &&
    typeof r.args === 'object' &&
    !Array.isArray(r.args) &&
    (r.bodyKey === undefined || typeof r.bodyKey === 'string')
  );
}

function isDraftAction(v: unknown): v is DraftAction {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  if (typeof r.id !== 'string' || !r.id) return false;
  if (typeof r.label !== 'string' || !r.label) return false;
  return isSendAction(r.sendAction);
}

function coerceString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  return undefined;
}

export const draftStoreWriteNode = fromPromise<
  Draft[],
  NodeHandlerInput<DraftStoreWriteParams>
>(async ({ input }) => {
  const { params, prev, ctx } = input;
  if (!params.source || typeof params.source !== 'string') {
    throw new Error('draft-store-write: params.source is required');
  }
  if (!Array.isArray(prev)) {
    return [];
  }
  const created: Draft[] = [];
  for (const raw of prev as IncomingDraft[]) {
    if (!raw || typeof raw !== 'object') continue;
    const channel = coerceString(raw.channel);
    const title = coerceString(raw.title);
    const body = coerceString(raw.body) ?? '';
    if (!channel || !title) {
      // Drop malformed rows silently — the workflow runner surfaces
      // the input via the run dock so the user can inspect.
      continue;
    }
    // Resolve actions[]:
    //   1. Use the new `actions` array if present + well-formed.
    //   2. Else, synthesize one from legacy { intent, sendAction }.
    //   3. Else skip.
    let actions: DraftAction[] = [];
    if (Array.isArray(raw.actions)) {
      actions = raw.actions.filter(isDraftAction);
    }
    if (actions.length === 0 && isSendAction(raw.sendAction)) {
      const intentRaw = coerceString(raw.intent);
      const isArchive = intentRaw === 'archive';
      actions = [
        {
          id: isArchive ? 'archive' : 'send',
          label: isArchive ? 'Archive' : 'Send',
          primary: true,
          requiresBody: !isArchive,
          sendAction: raw.sendAction,
        },
      ];
    }
    if (actions.length === 0) continue;
    const newDraft: NewDraft = {
      source: params.source,
      channel,
      sourceItemId: coerceString(raw.sourceItemId) ?? null,
      title,
      contextSummary: coerceString(raw.contextSummary) ?? null,
      contextFull: coerceString(raw.contextFull) ?? null,
      body,
      why: coerceString(raw.why) ?? null,
      actions,
      workflowId: ctx.workflowId ?? null,
    };
    created.push(ctx.drafts.create(newDraft));
  }
  return created;
});
