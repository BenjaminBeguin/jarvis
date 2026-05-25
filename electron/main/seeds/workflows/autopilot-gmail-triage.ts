import type { WorkflowDef } from '@shared/types';

/**
 * Autopilot scenario — triage Gmail inbox and produce drafts.
 *
 *   trigger:  autopilot · cron 10m (gated by appMode === 'autopilot')
 *   pipeline: mcp-call(gmail list_messages is:unread)
 *             → transform (filter + project)
 *             → run-skill (gmail-triage returns JSON array of drafts)
 *             → transform (parse JSON, drop ignored)
 *             → draft-store-write (writes to ai_drafts table)
 *
 * V1 is draft-only — the skill classifies + drafts, the user reviews
 * in the Drafts view, edits inline or refines via prompt, and clicks
 * Send to dispatch. No auto-archive or auto-reply yet; once you trust
 * the classifier, Phase B adds those branches.
 *
 * The `mcp: 'gmail'` short-form resolves to the first connected
 * Google account's gmail-<accountId> MCP (prefix fallback). For
 * deterministic multi-account, swap to the full id in this JSON.
 *
 * Default `enabled: false`. Enable from Settings → Workflows, then
 * flip the tray to autopilot mode to let it fire.
 */

const PROJECT_FN = `(() => {
  // mcp-call parse:'json' returns an array of text blocks; the Gmail
  // tool emits one block whose JSON is { messages, resultSizeEstimate }.
  const blocks = Array.isArray($) ? $ : [$];
  let payload = null;
  for (const b of blocks) {
    if (b && typeof b === 'object' && Array.isArray(b.messages)) {
      payload = b;
      break;
    }
  }
  const messages = payload?.messages ?? [];
  return messages.slice(0, 10).map((m) => {
    const h = m.headers || {};
    return {
      id: String(m.id || ''),
      threadId: String(m.threadId || ''),
      from: String(h.from || ''),
      subject: String(h.subject || '(no subject)'),
      snippet: String(m.snippet || '').slice(0, 300),
    };
  }).filter((r) => r.id && r.threadId && r.from);
})()`;

const AGENT_PROMPT = `Triage the following Gmail messages. Read \`~/.jarvis/triage-policy.md\` first; it governs what to archive, what to draft, what tone to use, and any per-person overrides.

Output a JSON array shaped exactly as your system prompt specifies — one row per non-ignored message, each carrying 1-3 LLM-chosen \`actions\` (Send / Archive / Star / Forward / Decline / Snooze / …) that match what THIS user would actually want to do with THIS message. Don't default to a single Send button.

Rules to internalize:
- For messages you'd \`ignore\` (receipts, password resets, transactional): drop the row entirely.
- For archive-worthy messages (newsletters, bot notifications, irrelevant promos): emit a row whose PRIMARY action is \`archive\` — \`requiresBody: false\` + sendAction \`modify_labels\` with \`removeLabelIds: ["INBOX"]\`. NEVER put \`(suggest archive — reason)\` in the body — archive is a real, dispatchable action now, not a hint.
- For real correspondence: emit a reply action as primary with a draft body the user can edit, plus contextual alternatives (Archive instead / Decline politely / Forward to X / Star for later) based on the message.
- The \`body\` field is what gets sent if the user picks any \`requiresBody: true\` action. Use it for reply text only. For archive-only rows: empty string.

Input messages:
\`\`\`json
{prev}
\`\`\`

Past feedback I've given on this scenario:
{feedback}

Return ONLY the JSON array. No prose, no markdown fences.`;

const PARSE_FN = `(() => {
  try {
    const text = typeof $ === 'string' ? $ : '';
    // Strip stray fences just in case.
    const m = text.match(/\\\`\\\`\\\`(?:json)?\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`/);
    const json = m ? m[1] : text.trim();
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
})()`;

export const AUTOPILOT_GMAIL_TRIAGE_WORKFLOW: WorkflowDef = {
  id: 'autopilot-gmail-triage',
  name: 'Autopilot · Triage Gmail',
  description:
    'Every 10 minutes in autopilot mode, classify unread Gmail and produce drafts you can review, edit, refine via prompt, and send from the Drafts view. Requires a connected Google account. No auto-archive or auto-reply yet — everything lands as a draft.',
  enabled: false,
  trigger: { kind: 'autopilot', when: 'cron', every: '10m' },
  pipeline: [
    {
      type: 'mcp-call',
      params: {
        mcp: 'gmail',
        tool: 'list_messages',
        args: {
          query: 'in:inbox is:unread newer_than:1d -from:me',
          maxResults: 30,
        },
        parse: 'json',
      },
    },
    {
      type: 'transform',
      params: { fn: PROJECT_FN },
    },
    {
      type: 'run-skill',
      params: {
        skillId: 'gmail-triage',
        prompt: AGENT_PROMPT,
      },
    },
    {
      type: 'transform',
      params: { fn: PARSE_FN },
    },
    {
      type: 'draft-store-write',
      params: { source: 'gmail-triage' },
    },
  ],
};
