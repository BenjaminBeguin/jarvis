import type { WorkflowDef } from '@shared/types';

/**
 * Autopilot scenario — for each unaddressed review comment on the
 * user's open PRs, draft a per-comment plan, judgment, and reply.
 *
 *   trigger:  autopilot · cron 15m
 *   pipeline: shell(gh search prs --author @me)
 *             → transform (parse + pick most-recently-updated PR)
 *             → run-skill (pr-address-comments returns JSON array,
 *                          one row per comment)
 *             → batch-prompt-output (table HUD, per-comment Accept)
 *
 * The user sees a row per individual review comment:
 *   - file:line + reviewer cells
 *   - the agent's plan (1-2 sentences) as the draft body
 *   - verdict chip: should-do vs ignore — agent's judgment on whether
 *     the comment is worth acting on
 *   - expandable context with the original comment text + the
 *     proposed reply
 *
 * Accept saves positive feedback. Code changes / replies are NOT
 * auto-applied. The user manually pushes a fix + replies on GitHub.
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

const AGENT_PROMPT = `You're given ONE pull request the user authored. Look at the unaddressed review comments and produce one row per comment with a plan, judgment, and reply draft.

**Do NOT push code, post comments, or use any gh write command.** Use gh api to read inline comments (gh api repos/<owner>/<repo>/pulls/<num>/comments). Use gh pr diff to see the changes if you need context. Output only.

For each unaddressed comment, produce one object with:
  - id: stable id (use the comment id from gh api, e.g. "comment-12345")
  - pr: short PR ref (owner/repo#num)
  - file: path
  - line: number (the comment's anchor line)
  - by: reviewer handle
  - comment: the comment text (verbatim, truncated to ~200 chars)
  - verdict: "should-do" | "ignore"
  - plan: 1-2 sentences describing the change you'd make if "should-do" (or empty if ignore)
  - reply: the reply text you'd post on GitHub (1-2 sentences)

Input PR:
\`\`\`json
{prev}
\`\`\`

Past feedback the user has given you on this scenario:
{feedback}

Be selective. Style nits the user has previously waved off → "ignore" with an empty plan. Real bugs / behavior changes → "should-do".

Output ONLY a JSON array of comment rows. No prose, no markdown code fences.`;

const ROWS_FN = `(Array.isArray($) ? $ : []).filter(r => r && r.id).map(r => ({
  id: String(r.id),
  preview: [
    { label: 'PR',      value: String(r.pr || '?') },
    { label: 'File',    value: String(r.file || '?') + ':' + String(r.line || '?') },
    { label: 'By',      value: String(r.by || '?') },
    { label: 'Comment', value: String(r.comment || '').slice(0, 160) },
  ],
  draft: String(r.plan || '(ignore — no code change planned)'),
  verdict: r.verdict === 'should-do' ? 'should-do' : 'ignore',
  context: 'Original comment:\\n' + String(r.comment || '') + '\\n\\nDraft reply:\\n' + String(r.reply || ''),
}))`;

export const AUTOPILOT_PR_COMMENTS_WORKFLOW: WorkflowDef = {
  id: 'autopilot-pr-comments-on-mine',
  name: 'Autopilot · Address comments on my PRs',
  description:
    'Every 15 min in autopilot mode, find your most recently-updated open PR and produce one row per unaddressed review comment: plan, verdict, reply. Reviewed as a table; nothing is posted or pushed.',
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
      type: 'run-skill',
      params: { skillId: 'pr-address-comments', prompt: AGENT_PROMPT },
    },
    {
      type: 'transform',
      params: {
        fn: `(() => { try { return JSON.parse(typeof $ === 'string' ? $ : '[]'); } catch { return []; } })()`,
      },
    },
    {
      type: 'batch-prompt-output',
      params: {
        title: 'Address PR comments',
        summary:
          'Autopilot grouped your PR\'s review comments. Accept = positive feedback (no code is pushed; no reply posted). Reject + note teaches the agent.',
        rowsFn: ROWS_FN,
        onEmpty: 'skip',
      },
    },
  ],
};
