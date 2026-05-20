import type { WorkflowDef } from '@shared/types';

/**
 * Autopilot scenario — draft first-pass reviews for PRs requesting
 * the user's review where the author isn't on their team.
 *
 *   trigger:  autopilot · cron 15m (gated by appMode === 'autopilot')
 *   pipeline: shell(gh search prs --review-requested @me)
 *             → transform (parse + filter by authorAssociation)
 *             → run-skill (pr-review-queue returns JSON array)
 *             → batch-prompt-output (table HUD)
 *
 * The user sees a table — one row per PR — with:
 *   - title + repo + author cells
 *   - the agent's draft review summary
 *   - the proposed verdict chip (approve / comment / request-changes)
 *   - expandable context with the inline comments the agent would
 *     attach if posting
 *
 * Accept saves positive feedback to the per-workflow memory file;
 * the review is NOT auto-posted. The user opens the PR and decides
 * whether to mirror the draft. Future iteration adds an opt-in
 * mcp-call to gh pr review on accepted rows.
 *
 * Default `enabled: false`.
 */

const FILTER_FN = `(() => {
  const items = Array.isArray($) ? $ : [];
  // Keep PRs where the author is NOT an OWNER / MEMBER / COLLABORATOR
  // of the repo — i.e. external or non-team contributors. Edit the
  // allowlist if your team's GitHub-association shape differs.
  return items.filter(pr => {
    const assoc = String(pr.authorAssociation || '').toUpperCase();
    return assoc !== 'OWNER' && assoc !== 'MEMBER' && assoc !== 'COLLABORATOR';
  }).slice(0, 10);
})()`;

const AGENT_PROMPT = `You're given an array of pull requests requesting the user's review. For each one, draft a first-pass review WITHOUT posting it.

**Do NOT use \`gh pr review\`, \`gh pr comment\`, or any other gh write command.** Read-only gh commands (gh pr view, gh pr diff) are fine for gathering context. The user reviews your output and decides whether to mirror it.

For each input PR, produce one output row with:
  - id: stable id (e.g. owner/repo#number)
  - title: PR title
  - url: PR url
  - repo: owner/repo string
  - author: PR author handle
  - verdict: exactly one of "approve" | "comment" | "request-changes"
  - summary: 1-2 sentence overall take
  - comments: array of inline notes, each { file, line, body }. Empty array if just approving.

Input PRs:
\`\`\`json
{prev}
\`\`\`

Past feedback the user has given you on this scenario (match this tone / depth):
{feedback}

Be confident — "looks good" beats a manufactured nit. If nothing breaks, verdict is "approve" and comments is empty.

Output ONLY a JSON array. No prose, no markdown code fences.`;

const ROWS_FN = `(Array.isArray($) ? $ : []).filter(r => r && r.id).map(r => {
  const commentsText = Array.isArray(r.comments) && r.comments.length > 0
    ? r.comments.map(c => '  ' + (c.file || '?') + ':' + (c.line || '?') + ' — ' + (c.body || '').slice(0, 200)).join('\\n')
    : '(no inline comments)';
  return {
    id: r.id,
    preview: [
      { label: 'PR',     value: String(r.id || '?') },
      { label: 'Title',  value: String(r.title || '').slice(0, 80) },
      { label: 'Author', value: String(r.author || '?') },
    ],
    draft: String(r.summary || ''),
    verdict: String(r.verdict || 'comment'),
    context: 'Inline comments the agent would attach:\\n' + commentsText + '\\n\\nURL: ' + (r.url || '?'),
  };
})`;

export const AUTOPILOT_PR_REVIEW_NON_TEAM_WORKFLOW: WorkflowDef = {
  id: 'autopilot-pr-review-non-team',
  name: 'Autopilot · PR review (non-team)',
  description:
    'Every 15 min in autopilot mode, find PRs awaiting your review whose author is outside your team, draft a first-pass review per PR with verdict, and surface as a table for per-row approval.',
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
          '--review-requested',
          '@me',
          '--state',
          'open',
          '--json',
          'number,title,url,repository,author,authorAssociation,updatedAt',
          '--limit',
          '30',
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
      params: { skillId: 'pr-review-queue', prompt: AGENT_PROMPT },
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
        title: 'PRs awaiting your review',
        summary:
          'Autopilot drafted a review per non-team PR. Accept = positive feedback (review is NOT auto-posted). Reject + note teaches the agent.',
        rowsFn: ROWS_FN,
        onEmpty: 'skip',
      },
    },
  ],
};
