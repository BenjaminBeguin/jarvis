import type { WorkflowDef } from '@shared/types';

/**
 * Autopilot scenario — address unresolved comments on PRs you
 * authored, drafting the fix + reply for review.
 *
 *   trigger:  autopilot · cron 15m  (gated by appMode === 'autopilot')
 *   pipeline: shell(gh search) → transform → run-skill → prompt-output
 *
 * The prompt-output node BLOCKS for user approval before any code
 * change leaves the local working tree. On accept, the pipeline ends
 * (the next git push step is left out by default — opt-in by editing
 * the JSON and appending `{ type: 'shell', command: 'git', args:
 * ['push'] }`). On reject + feedback, the agent's drafting style
 * shifts on the next run via the {feedback} substitution.
 *
 * Default `enabled: false`. Flip from Settings → Workflows once
 * you've verified the gh CLI is authed and your PRs surface.
 */

const FILTER_FN = `(() => {
  const items = Array.isArray($) ? $ : [];
  // PRs I authored that have unresolved comments. gh search doesn't
  // expose "unresolved comments" directly, so we keep PRs with any
  // pending review state and let the agent decide.
  const mine = items.filter((pr) => pr.reviewDecision !== 'APPROVED' && pr.state === 'OPEN');
  if (mine.length === 0) return null;
  mine.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return mine[0];
})()`;

const AGENT_PROMPT = `Address the unresolved review comments on this PR. Read the diff + comments; decide what to change. Output a single markdown block with:

  1. **Fix plan** — a short bullet list of the edits you'd make
  2. **Reply** — the comment text you'd post to the reviewer
  3. **Diff** — a unified diff of the file changes (apply-ready)

PR data:
{prev}

Past feedback the user has given you on this scenario:
{feedback}

Output ONLY the markdown. The user will review and decide whether to apply + push.`;

export const AUTOPILOT_PR_COMMENTS_WORKFLOW: WorkflowDef = {
  id: 'autopilot-pr-comments-on-mine',
  name: 'Autopilot · Address comments on my PRs',
  description:
    'Every 15 min in autopilot mode, find one of your open PRs with unresolved comments and draft a fix + reply. Blocks for approval before anything leaves your machine.',
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
          'number,title,url,repository,reviewDecision,state,updatedAt',
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
      type: 'prompt-output',
      params: {
        title: 'Apply this PR fix?',
        summary: 'Autopilot drafted a code change + reply for one of your open PRs.',
      },
    },
  ],
};
