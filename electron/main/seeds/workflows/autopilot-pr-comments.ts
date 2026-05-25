import type { WorkflowDef } from '@shared/types';

/**
 * Autopilot scenario — for each unaddressed review comment on the
 * user's most-recently-updated open PR, draft a reply ready to be
 * posted from the Drafts tab.
 *
 *   trigger:  autopilot · cron 15m (gated by appMode === 'autopilot')
 *   pipeline: shell(gh search prs --author @me)
 *             → transform (parse + pick most-recently-updated PR)
 *             → run-skill (pr-comments-triage returns JSON array)
 *             → transform (parse JSON)
 *             → draft-store-write (writes to ai_drafts table)
 *
 * Each row in the Drafts view is one inline-comment reply. The
 * sendAction is a shell call to `gh api ... /replies` so Send
 * actually posts the reply (no manual gh round-trip needed).
 *
 * Default `enabled: false`.
 */

const FILTER_FN = `(() => {
  const items = Array.isArray($) ? $ : [];
  if (items.length === 0) return null;
  // Pick the most-recently-updated open PR. The agent fetches the
  // comments via gh api itself.
  const sorted = items.slice().sort((a, b) =>
    Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  return sorted[0];
})()`;

const AGENT_PROMPT = `You're given ONE pull request the user authored. Triage the unaddressed review comments and produce drafts ready to reply — see your system prompt for the exact JSON shape (\`draft-store-write\` + shell sendAction).

Input PR:
\`\`\`json
{prev}
\`\`\`

Past feedback the user has given on this scenario:
{feedback}

Output ONLY a JSON array of draft objects. No prose, no markdown fences.`;

const PARSE_FN = `(() => {
  try {
    const text = typeof $ === 'string' ? $ : '';
    const m = text.match(/\\\`\\\`\\\`(?:json)?\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`/);
    const json = m ? m[1] : text.trim();
    const arr = JSON.parse(json);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
})()`;

export const AUTOPILOT_PR_COMMENTS_WORKFLOW: WorkflowDef = {
  id: 'autopilot-pr-comments-on-mine',
  name: 'Autopilot · Triage PR comments',
  description:
    'Every 15 min in autopilot mode, find your most recently-updated open PR and draft a reply for each unaddressed review comment. Drafts land in the Drafts tab — edit, refine via prompt, send with one click (posts to GitHub via gh api).',
  enabled: false,
  trigger: { kind: 'autopilot', when: 'cron', every: '15m' },
  pipeline: [
    {
      type: 'shell',
      params: {
        cmd: 'gh',
        args: [
          'search',
          'prs',
          '--author',
          '@me',
          '--state',
          'open',
          '--json',
          'number,title,url,repository,updatedAt',
          '--limit',
          '20',
        ],
        timeoutMs: 30_000,
      },
    },
    {
      type: 'transform',
      params: {
        fn: `(() => { try { return JSON.parse(typeof $ === 'string' ? $ : '[]'); } catch { return []; } })()`,
      },
    },
    {
      type: 'transform',
      params: { fn: FILTER_FN },
    },
    {
      // FILTER_FN returns null when the user has no open PRs. Skip
      // the agent turn in that case rather than feeding the literal
      // string "null" into the prompt.
      type: 'run-skill',
      optional: true,
      params: { skillId: 'pr-comments-triage', prompt: AGENT_PROMPT },
    },
    {
      type: 'transform',
      params: { fn: PARSE_FN },
    },
    {
      type: 'draft-store-write',
      params: { source: 'pr-comments-triage' },
    },
  ],
};
