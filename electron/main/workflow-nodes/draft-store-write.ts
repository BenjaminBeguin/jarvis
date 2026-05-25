import { fromPromise } from 'xstate';

import type { Draft, NewDraft, SendAction } from '@shared/types';

import type { NodeHandlerInput } from './types.js';

/**
 * Append-only writer for the AI Drafts store. Any triage/autopilot
 * workflow whose final output is "drafts the user should review" ends
 * with this node — Gmail triage, future Slack triage, social DMs, PR
 * comment drafts. The renderer then shows everything in one Drafts
 * view; per-channel dispatch lives in each row's `sendAction`.
 *
 * Params:
 *   {
 *     source: string;   // producer id ('gmail-triage', 'slack-triage', …)
 *   }
 *
 * Input (prev): an array of draft objects shaped for `NewDraft`:
 *   {
 *     sourceItemId?: string,    // natural id from the upstream channel
 *     channel: string,          // 'gmail' | 'slack' | 'github' | ...
 *     title: string,
 *     contextSummary?: string,
 *     contextFull?: string,
 *     body: string,             // the AI-drafted reply text
 *     why?: string,             // one-sentence reasoning
 *     sendAction: {
 *       mcp, tool, args, bodyKey
 *     }
 *   }
 *
 * Dedup: if a draft for `(source, sourceItemId)` already exists, the
 * store returns the existing row instead of inserting a duplicate.
 * Producers that don't have a natural id just omit it.
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
  sendAction?: unknown;
}

function isSendAction(v: unknown): v is SendAction {
  if (!v || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  // Shell variant — needs cmd + args[]
  if (r.kind === 'shell') {
    return typeof r.cmd === 'string' && Array.isArray(r.args);
  }
  // MCP variant (default) — needs mcp + tool + args object. bodyKey
  // is optional: present for body-carrying sends (reply); absent
  // for body-less actions like archive (modify_labels).
  return (
    typeof r.mcp === 'string' &&
    typeof r.tool === 'string' &&
    r.args !== null &&
    typeof r.args === 'object' &&
    !Array.isArray(r.args) &&
    (r.bodyKey === undefined || typeof r.bodyKey === 'string')
  );
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
    // Empty/undefined input is a no-op rather than an error so an
    // upstream "no candidates" run still ends cleanly.
    return [];
  }
  const created: Draft[] = [];
  for (const raw of prev as IncomingDraft[]) {
    if (!raw || typeof raw !== 'object') continue;
    const channel = coerceString(raw.channel);
    const title = coerceString(raw.title);
    const body = coerceString(raw.body);
    if (!channel || !title || !body) {
      // Drop malformed rows silently — the workflow runner already
      // surfaces the input via the run dock, so the user can inspect.
      continue;
    }
    if (!isSendAction(raw.sendAction)) continue;
    const intentRaw = coerceString(raw.intent);
    const intent: 'reply' | 'archive' =
      intentRaw === 'archive' ? 'archive' : 'reply';
    const newDraft: NewDraft = {
      source: params.source,
      channel,
      sourceItemId: coerceString(raw.sourceItemId) ?? null,
      intent,
      title,
      contextSummary: coerceString(raw.contextSummary) ?? null,
      contextFull: coerceString(raw.contextFull) ?? null,
      body,
      why: coerceString(raw.why) ?? null,
      sendAction: raw.sendAction,
      workflowId: ctx.workflowId ?? null,
    };
    created.push(ctx.drafts.create(newDraft));
  }
  return created;
});
